// spacewalk-scan: fast, read-only disk usage scanner for macOS.
//
// Walks one or more directory trees in parallel with getattrlistbulk(2) and
// reads metadata only: names, types, allocated sizes, link counts, clone
// information, dates. File contents are never opened. Each root is scanned on
// its own volume; mount points and firmlinks into other volumes are recorded,
// not followed. Data stored once but reachable from several places (hard
// links, whole-file APFS clones) counts once, split evenly among those
// places. Cloud placeholders are never downloaded. Folders that macOS guards
// with a permission prompt are opened only when access is already granted
// (see --protected), so a scan never puts a prompt on the Mac's screen.
//
// stdout carries NDJSON events (start, progress, done, error). The finished
// tree is written as a compact binary snapshot (see write_snapshot) that the
// Spacewalk server loads with typed arrays.
//
// Build: clang -O2 -Wall -Wextra -framework CoreFoundation -o spacewalk-scan scan.c

#include <sys/attr.h>
#include <sys/mount.h>
#include <sys/param.h>
#include <sys/resource.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/vnode.h>

#include <CoreFoundation/CoreFoundation.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pthread.h>
#include <pwd.h>
#include <signal.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

#define MAX_ROOTS 16
#define SNAPSHOT_VERSION 2
#define STUCK_MS 1500       // a listing that shows no sign of life this long counts as stuck
#define MAX_MAIN_SPARES 16  // extra threads started to route around stuck folders
#define MAX_GATE_SPARES 8
#define GRACE_MS 8000       // wait on stuck folders this long once everything else is done

enum {
    NF_DIR = 1 << 0,        // directory
    NF_LOCKED = 1 << 1,     // could not be read (permissions or privacy protection)
    NF_OTHERFS = 1 << 2,    // mount point or firmlink into another volume, not followed
    NF_HARDLINK = 1 << 3,   // file with more than one hard link, counted once
    NF_DATALESS = 1 << 4,   // cloud placeholder whose contents are not on this disk
    NF_STALLED = 1 << 5,    // the scan stopped waiting on this folder
    NF_PARTIAL = 1 << 6,    // listing ended early on an error
    NF_ROOT = 1 << 7,       // one of the requested scan roots
    NF_CLONE = 1 << 8,      // shares all of its blocks with another file, counted once
    NF_SHARED = 1 << 9,     // may share some blocks with other files
    NF_PURGEABLE = 1 << 10, // macOS may remove it on its own when space runs low
    NF_GATED = 1 << 11,     // folder that macOS may guard with a consent prompt
    NF_SKIPPED = 1 << 12,   // not opened because the caller asked to skip it
    NF_ASK = 1 << 13,       // not opened because macOS would ask first; err holds the SVC_ service
};

// macOS privacy services that guard folders a scan meets.
enum { SVC_NONE, SVC_ALL_FILES, SVC_APP_DATA, SVC_DESKTOP, SVC_DOCUMENTS, SVC_DOWNLOADS, SVC_FILE_PROVIDER, SVC_COUNT };

static const char *const svc_tcc[SVC_COUNT] = {
    NULL,
    "kTCCServiceSystemPolicyAllFiles",
    "kTCCServiceSystemPolicyAppData",
    "kTCCServiceSystemPolicyDesktopFolder",
    "kTCCServiceSystemPolicyDocumentsFolder",
    "kTCCServiceSystemPolicyDownloadsFolder",
    "kTCCServiceFileProviderDomain",
};
static const char *const svc_key[SVC_COUNT] = {NULL, "fullDisk", "appData", "desktop", "documents", "downloads", "cloud"};

enum { ACC_GRANTED, ACC_DENIED, ACC_ASK, ACC_UNKNOWN };
static const char *const acc_name[] = {"granted", "denied", "ask", "unknown"};

// What to do with a folder whose service this process does not hold yet.
enum { PROTECTED_AUTO, PROTECTED_ASK, PROTECTED_SKIP };
static const char *const protected_name[] = {"auto", "ask", "skip"};

typedef struct node {
    struct node *parent;
    struct node *_Atomic first_child;
    struct node *next_sibling;
    _Atomic uint64_t size;  // allocated bytes in the subtree, shared data split evenly among its holders
    _Atomic uint64_t full;  // allocated bytes in the subtree, every copy and name counted in full
    _Atomic uint64_t priv;  // bytes that deleting the subtree frees at least (APFS private size)
    _Atomic uint32_t files; // files (and other non-folders) in the subtree
    _Atomic uint32_t dirs;  // folders in the subtree, excluding itself
    double small_bytes;     // direct files below the keep threshold
    double share_adj;       // set by share_evenly: this subtree's even share minus what it carried
    uint32_t small_count;
    uint32_t mtime;         // newest modification among itself and direct small files
    uint32_t out;           // index in the snapshot
    uint16_t name_len;
    _Atomic uint16_t flags;
    uint8_t vol;            // which root this node belongs to
    uint8_t err;            // errno when the folder could not be read
    char name[];
} node;

typedef struct {
    char *cur, *end;
} arena;

enum { LANE_MAIN, LANE_GATE };

// One place that holds shared data: a name of a hard-linked file or a full
// APFS clone. During the scan the first place found carries all the bytes;
// share_evenly then splits them among every place that holds them.
typedef struct {
    uint64_t key;  // what the data is: clone id or file id, mixed
    node *at;      // the file's own node, or its folder when the file is small
    uint64_t bits; // allocated bytes, plus the SH_ marks below
} sighting;

#define SH_COUNTED (1ULL << 63) // carried the bytes during the scan
#define SH_SMALL (1ULL << 62)   // small file, folded into its folder's small_bytes
#define SH_BYTES (SH_SMALL - 1)

typedef struct {
    pthread_t thread;
    int lane;
    arena mem;
    char *buf;
    size_t buf_size;
    node **kids; // child folders found by the last listing
    size_t kids_len, kids_cap;
    node **gated; // child folders that macOS may guard with a consent prompt
    size_t gated_len, gated_cap;
    sighting *sh; // shared files seen by the last listing
    size_t sh_len, sh_cap;
    node *_Atomic current;
    _Atomic uint64_t beat_ms; // last sign of life
    _Atomic bool alive;
} worker;

typedef struct {
    char *parent; // path of the folder that contains the entry
    char *base;   // name of the entry inside that folder
} path_entry;

// A short list of folder paths (mount points, folders to skip), split into
// parent and name so a listing can test each child cheaply.
typedef struct {
    path_entry *v;
    int len, cap;
} path_set;

static struct {
    int count;
    char *path[MAX_ROOTS];
    char *name[MAX_ROOTS];
    fsid_t fsid[MAX_ROOTS];
    node *node[MAX_ROOTS];
} roots;

// Two stacks of folders waiting to be listed. Folders that macOS may guard
// with a consent prompt (other apps' data, Desktop, Documents, cloud drives)
// go on the gate stack and are opened by their own small set of threads, so
// an unanswered prompt or a hung folder never holds up the rest of the scan.
static struct {
    pthread_mutex_t mu;
    pthread_cond_t work_cv;
    pthread_cond_t gate_cv;
    pthread_cond_t done_cv;
    node **items;
    size_t len, cap;
    node **gitems;
    size_t glen, gcap;
    size_t pending; // queued plus in progress, both stacks
    bool stop;
    sighting *sh; // every shared file seen by finished listings
    size_t shlen, shcap;
} queue = {PTHREAD_MUTEX_INITIALIZER, PTHREAD_COND_INITIALIZER, PTHREAD_COND_INITIALIZER, PTHREAD_COND_INITIALIZER,
           NULL, 0, 0, NULL, 0, 0, 0, false, NULL, 0, 0};

static node *top;
static worker *workers; // fixed capacity, so threads can be added while others read it
static _Atomic int nthreads;
static int nworkers = 16;
static uint64_t min_file = 1 << 20;
static int interval_ms = 250;
static int stall_seconds = 20;
static const char *out_path;
static struct attrlist bulk_attrs;
static path_set mounts, skips;
static const char *test_hang; // test hook: folders with this name never answer
static int protected_mode = PROTECTED_AUTO;
static int access_state[SVC_COUNT]; // ACC_ state of each service for this process
static bool may_open[SVC_COUNT];    // whether folders guarded by each service are opened
static _Atomic uint32_t node_count;
static _Atomic uint32_t locked_count;
static _Atomic uint32_t protected_count; // folders left unopened because macOS would ask first
static _Atomic uint32_t error_count;
static _Atomic uint64_t linked_bytes; // extra names of hard-linked files: a naive count adds them again
static _Atomic uint64_t cloned_bytes; // extra copies of APFS clones: a naive count adds them again
static _Atomic uint64_t heartbeat_ms;
static _Atomic bool frozen;
static double started_at;
static time_t started_wall;

// ---------------------------------------------------------------- utilities

static double now_s(void) {
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static uint64_t now_ms(void) { return (uint64_t)(now_s() * 1000.0); }

// Milliseconds from then to t. Other threads may stamp a time a moment after
// t was read, so this never underflows.
static uint64_t since(uint64_t t, uint64_t then) { return t > then ? t - then : 0; }

static void die(const char *msg) {
    fprintf(stdout, "{\"type\":\"error\",\"message\":\"%s\"}\n", msg);
    fflush(stdout);
    exit(2);
}

static void *xmalloc(size_t n) {
    void *p = malloc(n ? n : 1);
    if (!p) die("out of memory");
    return p;
}

static void *xrealloc(void *p, size_t n) {
    p = realloc(p, n);
    if (!p) die("out of memory");
    return p;
}

static void *arena_alloc(arena *a, size_t n) {
    n = (n + 7) & ~(size_t)7;
    if ((size_t)(a->end - a->cur) < n) {
        size_t chunk = n > (1u << 20) ? n : (1u << 20);
        a->cur = xmalloc(chunk);
        a->end = a->cur + chunk;
    }
    void *p = a->cur;
    a->cur += n;
    return p;
}

static bool fsid_eq(fsid_t a, fsid_t b) { return a.val[0] == b.val[0] && a.val[1] == b.val[1]; }

static uint16_t flags_of(node *n) { return atomic_load_explicit(&n->flags, memory_order_relaxed); }

static void set_flags(node *n, uint16_t f) { atomic_fetch_or_explicit(&n->flags, f, memory_order_relaxed); }

// A growable byte buffer for JSON output.
typedef struct {
    char *p;
    size_t len, cap;
} sbuf;

static void sb_grow(sbuf *b, size_t extra) {
    if (b->len + extra + 1 > b->cap) {
        size_t cap = b->cap ? b->cap * 2 : 4096;
        while (cap < b->len + extra + 1) cap *= 2;
        b->p = xrealloc(b->p, cap);
        b->cap = cap;
    }
}

static void sb_put(sbuf *b, const char *s, size_t n) {
    sb_grow(b, n);
    memcpy(b->p + b->len, s, n);
    b->len += n;
    b->p[b->len] = 0;
}

static void sb_puts(sbuf *b, const char *s) { sb_put(b, s, strlen(s)); }

static void sb_printf(sbuf *b, const char *fmt, ...) __attribute__((format(printf, 2, 3)));
static void sb_printf(sbuf *b, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    char tmp[512];
    int n = vsnprintf(tmp, sizeof tmp, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    if ((size_t)n < sizeof tmp) {
        sb_put(b, tmp, (size_t)n);
        return;
    }
    sb_grow(b, (size_t)n);
    va_start(ap, fmt);
    vsnprintf(b->p + b->len, (size_t)n + 1, fmt, ap);
    va_end(ap);
    b->len += (size_t)n;
}

static void sb_json_str(sbuf *b, const char *s, size_t n) {
    sb_put(b, "\"", 1);
    for (size_t i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c == '"' || c == '\\') {
            char e[2] = {'\\', (char)c};
            sb_put(b, e, 2);
        } else if (c < 0x20) {
            char e[8];
            snprintf(e, sizeof e, "\\u%04x", c);
            sb_put(b, e, 6);
        } else {
            sb_put(b, (const char *)&c, 1);
        }
    }
    sb_put(b, "\"", 1);
}

static void emit(sbuf *b) {
    sb_put(b, "\n", 1);
    if (fwrite(b->p, 1, b->len, stdout) != b->len || fflush(stdout) != 0) {
        // The reader went away; there is nobody left to report to.
        _exit(3);
    }
    b->len = 0;
}

// ---------------------------------------------------------------- shared files

// Files with several hard links, and files that share every block with an
// APFS clone, carry their bytes at the first sighting only while the scan
// runs, so live totals never count them twice. The set is striped so
// threads rarely contend.
#define SEEN_STRIPES 64

typedef struct {
    pthread_mutex_t mu;
    uint64_t *keys; // 0 marks an empty slot; stored keys are never 0
    size_t cap, len;
} seen_stripe;

static seen_stripe seen[SEEN_STRIPES];

static uint64_t mix64(uint64_t x) {
    x ^= x >> 33;
    x *= 0xff51afd7ed558ccdULL;
    x ^= x >> 33;
    x *= 0xc4ceb9fe1a85ec53ULL;
    x ^= x >> 33;
    return x;
}

static bool seen_insert_slot(uint64_t *keys, size_t cap, uint64_t key) {
    size_t i = (size_t)(key >> 7) & (cap - 1);
    for (;;) {
        if (keys[i] == key) return false;
        if (keys[i] == 0) {
            keys[i] = key;
            return true;
        }
        i = (i + 1) & (cap - 1);
    }
}

// kind 0: file id of a hard-linked file; kind 1: clone id of a cloned file.
// Every name of every copy of a clone reports the same clone id.
static uint64_t share_key(int kind, uint8_t vol, uint64_t id) {
    return mix64(id ^ ((uint64_t)(vol + 1) << 56) ^ (kind ? 0x9e3779b97f4a7c15ULL : 0)) | 1;
}

static bool first_sighting(uint64_t key) {
    seen_stripe *s = &seen[key % SEEN_STRIPES];
    pthread_mutex_lock(&s->mu);
    if (s->len * 2 >= s->cap) {
        size_t cap = s->cap ? s->cap * 2 : 1024;
        uint64_t *keys = calloc(cap, sizeof *keys);
        if (!keys) die("out of memory");
        for (size_t i = 0; i < s->cap; i++)
            if (s->keys[i]) seen_insert_slot(keys, cap, s->keys[i]);
        free(s->keys);
        s->keys = keys;
        s->cap = cap;
    }
    bool fresh = seen_insert_slot(s->keys, s->cap, key);
    if (fresh) s->len++;
    pthread_mutex_unlock(&s->mu);
    return fresh;
}

// ---------------------------------------------------------------- tree

static node *new_node(arena *a, node *parent, const char *name, size_t len, uint16_t flags) {
    if (len > 0xffff) len = 0xffff;
    node *n = arena_alloc(a, sizeof(node) + len + 1);
    memset(n, 0, sizeof(node));
    n->parent = parent;
    memcpy(n->name, name, len);
    n->name[len] = 0;
    n->name_len = (uint16_t)len;
    atomic_init(&n->flags, flags);
    n->vol = parent ? parent->vol : 0;
    atomic_fetch_add_explicit(&node_count, 1, memory_order_relaxed);
    return n;
}

static void publish_child(node *parent, node *child) {
    child->next_sibling = atomic_load_explicit(&parent->first_child, memory_order_relaxed);
    atomic_store_explicit(&parent->first_child, child, memory_order_release);
}

static void add_up(node *from, uint64_t bytes, uint64_t full, uint64_t priv, uint32_t files, uint32_t dirs) {
    if (!bytes && !full && !priv && !files && !dirs) return;
    for (node *a = from; a; a = a->parent) {
        if (bytes) atomic_fetch_add_explicit(&a->size, bytes, memory_order_relaxed);
        if (full) atomic_fetch_add_explicit(&a->full, full, memory_order_relaxed);
        if (priv) atomic_fetch_add_explicit(&a->priv, priv, memory_order_relaxed);
        if (files) atomic_fetch_add_explicit(&a->files, files, memory_order_relaxed);
        if (dirs) atomic_fetch_add_explicit(&a->dirs, dirs, memory_order_relaxed);
    }
}

// Writes the full path of n into buf. Returns its length, or -1 if it does
// not fit (the caller then walks the path one component at a time).
static int node_path(node *n, char *buf, size_t cap) {
    node *chain[PATH_MAX / 2];
    int depth = 0;
    node *p = n;
    while (p && !(flags_of(p) & NF_ROOT)) {
        if (depth == (int)(sizeof chain / sizeof chain[0])) return -1;
        chain[depth++] = p;
        p = p->parent;
    }
    if (!p) return -1;
    const char *rp = roots.path[p->vol];
    size_t len = strlen(rp);
    if (len + 1 > cap) return -1;
    memcpy(buf, rp, len);
    if (len == 1 && buf[0] == '/') len = 0;
    for (int i = depth - 1; i >= 0; i--) {
        size_t nl = chain[i]->name_len;
        if (len + 1 + nl + 1 > cap) return -1;
        buf[len++] = '/';
        memcpy(buf + len, chain[i]->name, nl);
        len += nl;
    }
    if (len == 0) buf[len++] = '/';
    buf[len] = 0;
    return (int)len;
}

static int open_dir_node(node *d, char *path, size_t cap) {
    int flags = O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC;
    if (node_path(d, path, cap) >= 0) {
        if (flags_of(d) & NF_ROOT) flags &= ~O_NOFOLLOW; // a root may be given as a symlink
        return open(path, flags);
    }
    // Path longer than PATH_MAX: descend one component at a time.
    path[0] = 0;
    size_t depth = 0;
    for (node *p = d; p && !(flags_of(p) & NF_ROOT); p = p->parent) depth++;
    node **chain = xmalloc(depth * sizeof *chain);
    node *p = d;
    for (size_t i = depth; i > 0; i--, p = p->parent) chain[i - 1] = p;
    int fd = open(roots.path[d->vol], O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    for (size_t i = 0; fd >= 0 && i < depth; i++) {
        int next = openat(fd, chain[i]->name, flags);
        int saved = errno;
        close(fd);
        errno = saved;
        fd = next;
    }
    free(chain);
    return fd;
}

// ---------------------------------------------------------------- mounts

static void path_set_add(path_set *s, const char *path) {
    const char *slash = strrchr(path, '/');
    if (!slash || slash[1] == 0) return;
    if (s->len == s->cap) {
        s->cap = s->cap ? s->cap * 2 : 16;
        s->v = xrealloc(s->v, (size_t)s->cap * sizeof *s->v);
    }
    path_entry *e = &s->v[s->len++];
    size_t plen = (size_t)(slash - path);
    e->parent = plen ? strndup(path, plen) : strdup("/");
    e->base = strdup(slash + 1);
}

// Adds path and, for a path that reaches the data volume through a
// firmlink (/Users, /Volumes, /Applications, ...), its form under
// /System/Volumes/Data, so it matches however the scan root is spelled.
static void path_set_add_both(path_set *s, const char *path) {
    path_set_add(s, path);
    if (path[0] == '/' && strncmp(path, "/System/", 8) != 0) {
        char alias[MAXPATHLEN + 32];
        snprintf(alias, sizeof alias, "/System/Volumes/Data%s", path);
        path_set_add(s, alias);
    }
}

// True when the set holds the child name of the folder at parent_path.
// checked and any cache, per folder, whether the folder holds any entry.
static bool path_set_has(const path_set *s, const char *parent_path, bool *checked, bool *any, const char *name) {
    if (!s->len) return false;
    if (!*checked) {
        *checked = true;
        *any = false;
        for (int i = 0; i < s->len && !*any; i++)
            if (strcmp(s->v[i].parent, parent_path) == 0) *any = true;
    }
    if (!*any) return false;
    for (int i = 0; i < s->len; i++)
        if (strcmp(s->v[i].base, name) == 0 && strcmp(s->v[i].parent, parent_path) == 0) return true;
    return false;
}

static void load_mounts(void) {
    int n = getfsstat(NULL, 0, MNT_NOWAIT);
    if (n <= 0) return;
    struct statfs *list = xmalloc((size_t)n * sizeof *list);
    n = getfsstat(list, n * (int)sizeof *list, MNT_NOWAIT);
    for (int i = 0; i < n; i++) {
        const char *m = list[i].f_mntonname;
        if (strcmp(m, "/") == 0) continue;
        // /Volumes is a firmlink into the data volume, so a mount at
        // /Volumes/X also appears at /System/Volumes/Data/Volumes/X.
        if (strncmp(m, "/Volumes/", 9) == 0) path_set_add_both(&mounts, m);
        else path_set_add(&mounts, m);
    }
    free(list);
}

// ---------------------------------------------------------------- access

// Full Disk Access, tested on folders that refuse without a prompt when it
// is missing.
static int probe_full_disk(void) {
    const char *home = getenv("HOME");
    if (!home || home[0] != '/') {
        struct passwd *pw = getpwuid(getuid());
        home = pw ? pw->pw_dir : NULL;
    }
    static const char *const probes[] = {"~/Library/Mail", "~/Library/Safari",
                                         "/Library/Application Support/com.apple.TCC"};
    int state = ACC_UNKNOWN;
    char path[PATH_MAX];
    for (size_t i = 0; i < sizeof probes / sizeof probes[0]; i++) {
        if (probes[i][0] == '~' && !home) continue;
        if (probes[i][0] == '~') snprintf(path, sizeof path, "%s%s", home, probes[i] + 1);
        else snprintf(path, sizeof path, "%s", probes[i]);
        int fd = open(path, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
        if (fd >= 0) {
            close(fd);
            return ACC_GRANTED;
        }
        if (errno == EPERM || errno == EACCES) state = ACC_DENIED;
    }
    return state;
}

// Asks macOS, without putting anything on screen, which services this
// process already holds, then decides which guarded folders the scan opens.
// TCCAccessPreflight is private but long-standing: 0 granted, 1 denied,
// 2 would ask. Without it, Full Disk Access is probed and the other
// services count as unknown.
static void check_access(void) {
    typedef int (*preflight_fn)(CFStringRef, CFDictionaryRef);
    void *tcc = dlopen("/System/Library/PrivateFrameworks/TCC.framework/TCC", RTLD_LAZY | RTLD_LOCAL);
    preflight_fn preflight = tcc ? (preflight_fn)dlsym(tcc, "TCCAccessPreflight") : NULL;
    for (int s = 1; s < SVC_COUNT; s++) {
        access_state[s] = ACC_UNKNOWN;
        if (!preflight) continue;
        CFStringRef service = CFStringCreateWithCString(NULL, svc_tcc[s], kCFStringEncodingUTF8);
        if (!service) continue;
        int r = preflight(service, NULL);
        CFRelease(service);
        if (r >= ACC_GRANTED && r <= ACC_ASK) access_state[s] = r;
    }
    if (access_state[SVC_ALL_FILES] == ACC_UNKNOWN) access_state[SVC_ALL_FILES] = probe_full_disk();
    bool full_disk = access_state[SVC_ALL_FILES] == ACC_GRANTED;
    for (int s = 1; s < SVC_COUNT; s++) {
        // Full Disk Access covers other apps' data and the home folders;
        // each cloud provider still asks for itself.
        bool granted = access_state[s] == ACC_GRANTED || (full_disk && s != SVC_FILE_PROVIDER);
        may_open[s] = protected_mode == PROTECTED_ASK || (protected_mode == PROTECTED_AUTO && granted);
    }
}

static void sb_access(sbuf *b) {
    sb_printf(b, ",\"protectedMode\":\"%s\",\"access\":{", protected_name[protected_mode]);
    for (int s = 1; s < SVC_COUNT; s++)
        sb_printf(b, "%s\"%s\":\"%s\"", s > 1 ? "," : "", svc_key[s], acc_name[access_state[s]]);
    sb_put(b, "}", 1);
}

// ---------------------------------------------------------------- scanning

static void mark_unreadable(node *d, int err) {
    d->err = (uint8_t)(err > 255 ? 255 : err);
    set_flags(d, NF_LOCKED);
    atomic_fetch_add_explicit(&locked_count, 1, memory_order_relaxed);
}

static void vec_push(node ***v, size_t *len, size_t *cap, node *n) {
    if (*len == *cap) {
        *cap = *cap ? *cap * 2 : 256;
        *v = xrealloc(*v, *cap * sizeof **v);
    }
    (*v)[(*len)++] = n;
}

static bool name_is(const node *n, const char *s) {
    size_t len = strlen(s);
    return n && n->name_len == len && memcmp(n->name, s, len) == 0;
}

static bool str_is(const char *name, size_t len, const char *s) { return len == strlen(s) && memcmp(name, s, len) == 0; }

// The service guarding a folder that macOS may protect with a consent prompt
// instead of a plain refusal (other apps' data containers, the Desktop,
// Documents and Downloads folders, cloud drives, Photos libraries), or
// SVC_NONE.
static int gate_service(const node *parent, const char *name, size_t len) {
    const node *gp = parent ? parent->parent : NULL;
    if (name_is(gp, "Library") &&
        (name_is(parent, "Containers") || name_is(parent, "Group Containers") || name_is(parent, "Daemon Containers")))
        return SVC_APP_DATA;
    if (name_is(gp, "Users")) {
        if (str_is(name, len, "Desktop")) return SVC_DESKTOP;
        if (str_is(name, len, "Documents")) return SVC_DOCUMENTS;
        if (str_is(name, len, "Downloads")) return SVC_DOWNLOADS;
    }
    if (name_is(parent, "Library") && (str_is(name, len, "Mobile Documents") || str_is(name, len, "CloudStorage")))
        return SVC_FILE_PROVIDER;
    static const char lib[] = ".photoslibrary";
    if (len > sizeof lib - 1 && memcmp(name + len - (sizeof lib - 1), lib, sizeof lib - 1) == 0) return SVC_ALL_FILES;
    return SVC_NONE;
}

// The bytes only this file holds, for a file that may share some blocks with
// a clone. APFS works this out by walking the file's extents, which is slow
// (tens of microseconds per file even when nothing is shared), so it is
// asked one file at a time and only where it matters. It counts compressed
// files as 0, which keeps it a lower bound.
static uint64_t private_size(int dirfd, const char *name, uint64_t full) {
    struct attrlist al = {0};
    al.bitmapcount = ATTR_BIT_MAP_COUNT;
    al.commonattr = ATTR_CMN_RETURNED_ATTRS;
    al.forkattr = ATTR_CMNEXT_PRIVATESIZE;
    char buf[64];
    if (getattrlistat(dirfd, name, &al, buf, sizeof buf, FSOPT_NOFOLLOW | FSOPT_ATTR_CMN_EXTENDED) != 0) return 0;
    attribute_set_t ret;
    memcpy(&ret, buf + sizeof(uint32_t), sizeof ret);
    if (!(ret.forkattr & ATTR_CMNEXT_PRIVATESIZE)) return 0;
    off_t size;
    memcpy(&size, buf + sizeof(uint32_t) + sizeof ret, sizeof size);
    return size <= 0 ? 0 : (uint64_t)size < full ? (uint64_t)size : full;
}

// Lists one folder. Child folders are collected in w->kids and w->gated.
static void list_dir(worker *w, node *d) {
    char path[PATH_MAX];
    w->kids_len = 0;
    w->gated_len = 0;
    w->sh_len = 0;
    if (test_hang && strcmp(d->name, test_hang) == 0)
        for (;;) pause(); // test hook: behave like a folder that never answers
    int fd = open_dir_node(d, path, sizeof path);
    if (atomic_load(&frozen)) {
        if (fd >= 0) close(fd);
        return;
    }
    if (fd < 0) {
        mark_unreadable(d, errno);
        return;
    }
    struct statfs sfs;
    if (fstatfs(fd, &sfs) == 0 && !fsid_eq(sfs.f_fsid, roots.fsid[d->vol])) {
        set_flags(d, NF_OTHERFS);
        close(fd);
        return;
    }
    bool have_path = path[0] != 0, mounts_checked = false, has_mounts = false, skips_checked = false,
         has_skips = false;

    uint64_t direct_bytes = 0, direct_full = 0, direct_priv = 0, small_bytes = 0;
    uint32_t direct_files = 0, direct_dirs = 0, small_count = 0;
    uint32_t newest = d->mtime;
    bool any_entry = false;

    for (;;) {
        int n = getattrlistbulk(fd, &bulk_attrs, w->buf, w->buf_size, FSOPT_ATTR_CMN_EXTENDED);
        if (n < 0) {
            if (errno == EINTR) continue;
            if (any_entry) {
                d->err = (uint8_t)errno;
                set_flags(d, NF_PARTIAL);
            } else {
                mark_unreadable(d, errno);
            }
            break;
        }
        if (n == 0) break;
        uint64_t beat = now_ms();
        atomic_store_explicit(&heartbeat_ms, beat, memory_order_relaxed);
        atomic_store_explicit(&w->beat_ms, beat, memory_order_relaxed);
        if (atomic_load_explicit(&frozen, memory_order_relaxed)) break;
        any_entry = true;

        char *p = w->buf;
        for (int i = 0; i < n; i++) {
            char *entry = p;
            uint32_t len;
            memcpy(&len, p, sizeof len);
            char *q = p + sizeof len;
            p = entry + len;

            // Attributes follow in bit order within each group, and only
            // those listed in the returned set are present.
            attribute_set_t ret;
            memcpy(&ret, q, sizeof ret);
            q += sizeof ret;
            uint32_t err = 0;
            if (ret.commonattr & ATTR_CMN_ERROR) {
                memcpy(&err, q, sizeof err);
                q += sizeof err;
            }
            const char *name = NULL;
            size_t name_len = 0;
            if (ret.commonattr & ATTR_CMN_NAME) {
                attrreference_t ref;
                memcpy(&ref, q, sizeof ref);
                name = q + ref.attr_dataoffset;
                name_len = ref.attr_length ? ref.attr_length - 1 : 0;
                q += sizeof ref;
            }
            fsobj_type_t type = VNON;
            if (ret.commonattr & ATTR_CMN_OBJTYPE) {
                memcpy(&type, q, sizeof type);
                q += sizeof type;
            }
            struct timespec mod = {0, 0};
            if (ret.commonattr & ATTR_CMN_MODTIME) {
                memcpy(&mod, q, sizeof mod);
                q += sizeof mod;
            }
            uint32_t bsd_flags = 0;
            if (ret.commonattr & ATTR_CMN_FLAGS) {
                memcpy(&bsd_flags, q, sizeof bsd_flags);
                q += sizeof bsd_flags;
            }
            uint64_t fileid = 0;
            if (ret.commonattr & ATTR_CMN_FILEID) {
                memcpy(&fileid, q, sizeof fileid);
                q += sizeof fileid;
            }
            uint32_t links = 1;
            off_t alloc = 0;
            if (ret.fileattr & ATTR_FILE_LINKCOUNT) {
                memcpy(&links, q, sizeof links);
                q += sizeof links;
            }
            if (ret.fileattr & ATTR_FILE_ALLOCSIZE) {
                memcpy(&alloc, q, sizeof alloc);
                q += sizeof alloc;
            }
            uint64_t clone_id = 0, ext_flags = 0;
            if (ret.forkattr & ATTR_CMNEXT_CLONEID) {
                memcpy(&clone_id, q, sizeof clone_id);
                q += sizeof clone_id;
            }
            if (ret.forkattr & ATTR_CMNEXT_EXT_FLAGS) {
                memcpy(&ext_flags, q, sizeof ext_flags);
                q += sizeof ext_flags;
            }
            if (err || !name) {
                atomic_fetch_add_explicit(&error_count, 1, memory_order_relaxed);
                continue;
            }
            uint32_t mtime = mod.tv_sec > 0 ? (uint32_t)mod.tv_sec : 0;

            if (type == VDIR) {
                direct_dirs++;
                uint16_t flags = NF_DIR;
                if (bsd_flags & SF_DATALESS) flags |= NF_DATALESS;
                if (have_path && path_set_has(&mounts, path, &mounts_checked, &has_mounts, name)) flags |= NF_OTHERFS;
                if (have_path && path_set_has(&skips, path, &skips_checked, &has_skips, name)) flags |= NF_SKIPPED;
                int svc = gate_service(d, name, name_len);
                if (svc) {
                    flags |= NF_GATED;
                    if (!may_open[svc] && !(flags & (NF_DATALESS | NF_OTHERFS | NF_SKIPPED))) flags |= NF_ASK;
                }
                node *c = new_node(&w->mem, d, name, name_len, flags);
                c->mtime = mtime;
                if (flags & NF_ASK) {
                    c->err = (uint8_t)svc;
                    atomic_fetch_add_explicit(&protected_count, 1, memory_order_relaxed);
                }
                publish_child(d, c);
                if (!(flags & (NF_DATALESS | NF_OTHERFS | NF_SKIPPED | NF_ASK))) {
                    if (svc) vec_push(&w->gated, &w->gated_len, &w->gated_cap, c);
                    else vec_push(&w->kids, &w->kids_len, &w->kids_cap, c);
                }
                continue;
            }

            uint64_t full = alloc > 0 ? (uint64_t)alloc : 0, bytes = full;
            uint16_t flags = 0;
            uint64_t key = 0;
            bool clone = type == VREG && (ext_flags & EF_SHARES_ALL_BLOCKS) && clone_id;
            if (type == VREG && links > 1) flags |= NF_HARDLINK;
            if (clone) {
                flags |= NF_CLONE;
                key = share_key(1, d->vol, clone_id);
            } else if (type == VREG && links > 1) {
                key = share_key(0, d->vol, fileid);
            }
            if (!clone && (ext_flags & EF_MAY_SHARE_BLOCKS)) flags |= NF_SHARED;
            if (ext_flags & EF_IS_PURGEABLE) flags |= NF_PURGEABLE;
            if (bsd_flags & SF_DATALESS) flags |= NF_DATALESS;
            bool counted = true;
            if (key && full && !first_sighting(key)) {
                atomic_fetch_add_explicit(clone ? &cloned_bytes : &linked_bytes, full, memory_order_relaxed);
                bytes = 0;
                counted = false;
            }
            bool big = type == VREG && full >= min_file && full > 0;
            // What deleting this entry frees for certain: nothing for shared
            // data (another name or copy keeps it); for a file that may share
            // some blocks, its private size when it is large and nothing when
            // it is small; otherwise every allocated block.
            uint64_t freed = 0;
            if (!key) freed = !(flags & NF_SHARED) ? full : big ? private_size(fd, name, full) : 0;

            direct_files++;
            direct_bytes += bytes;
            direct_full += full;
            direct_priv += freed;
            node *at = d;
            if (big) {
                // Kept as its own node even when it carries 0 bytes, so a
                // clone or second hard link still shows where it lives.
                node *c = new_node(&w->mem, d, name, name_len, flags);
                atomic_init(&c->size, bytes);
                atomic_init(&c->full, full);
                atomic_init(&c->priv, freed);
                atomic_init(&c->files, 1);
                c->mtime = mtime;
                publish_child(d, c);
                at = c;
            } else {
                small_bytes += bytes;
                small_count++;
                if (mtime > newest) newest = mtime;
            }
            if (key && full) {
                if (w->sh_len == w->sh_cap) {
                    w->sh_cap = w->sh_cap ? w->sh_cap * 2 : 256;
                    w->sh = xrealloc(w->sh, w->sh_cap * sizeof *w->sh);
                }
                w->sh[w->sh_len++] = (sighting){key, at, full | (counted ? SH_COUNTED : 0) | (big ? 0 : SH_SMALL)};
            }
        }
    }
    close(fd);
    if (atomic_load(&frozen)) {
        // The scan is being written out; leave the counts as they were.
        set_flags(d, NF_STALLED);
        for (size_t i = 0; i < w->kids_len; i++) set_flags(w->kids[i], NF_STALLED);
        for (size_t i = 0; i < w->gated_len; i++) set_flags(w->gated[i], NF_STALLED);
        w->kids_len = w->gated_len = w->sh_len = 0;
        return;
    }
    d->small_bytes = (double)small_bytes;
    d->small_count = small_count;
    d->mtime = newest;
    add_up(d, direct_bytes, direct_full, direct_priv, direct_files, direct_dirs);
}

static void push_items(node ***items, size_t *len, size_t *cap, node **src, size_t n) {
    if (!n) return;
    if (*len + n > *cap) {
        *cap = (*len + n) * 2;
        *items = xrealloc(*items, *cap * sizeof **items);
    }
    memcpy(*items + *len, src, n * sizeof *src);
    *len += n;
}

static void *worker_main(void *arg) {
    worker *w = arg;
    node *next = NULL;
    for (;;) {
        node *d = next;
        next = NULL;
        if (!d) {
            pthread_mutex_lock(&queue.mu);
            bool gate = w->lane == LANE_GATE;
            for (;;) {
                size_t have = gate ? queue.glen : queue.len;
                if (have > 0 || queue.pending == 0 || queue.stop) break;
                pthread_cond_wait(gate ? &queue.gate_cv : &queue.work_cv, &queue.mu);
            }
            if (queue.stop || (gate ? queue.glen : queue.len) == 0) {
                pthread_mutex_unlock(&queue.mu);
                break;
            }
            d = gate ? queue.gitems[--queue.glen] : queue.items[--queue.len];
            pthread_mutex_unlock(&queue.mu);
        }
        atomic_store_explicit(&w->beat_ms, now_ms(), memory_order_relaxed);
        atomic_store_explicit(&w->current, d, memory_order_release);
        list_dir(w, d);
        atomic_store_explicit(&w->current, NULL, memory_order_release);
        atomic_store_explicit(&w->beat_ms, now_ms(), memory_order_relaxed);
        atomic_store_explicit(&heartbeat_ms, now_ms(), memory_order_relaxed);

        size_t k = w->kids_len, g = w->gated_len;
        pthread_mutex_lock(&queue.mu);
        if (queue.stop) {
            pthread_mutex_unlock(&queue.mu);
            break;
        }
        // This task is done and k + g new ones exist. A main-lane thread
        // keeps one child for itself (depth-first locality) and shares the rest.
        size_t shared = k;
        if (k > 0 && w->lane == LANE_MAIN) {
            next = w->kids[k - 1];
            shared = k - 1;
        }
        push_items(&queue.items, &queue.len, &queue.cap, w->kids, shared);
        push_items(&queue.gitems, &queue.glen, &queue.gcap, w->gated, g);
        if (w->sh_len) {
            if (queue.shlen + w->sh_len > queue.shcap) {
                queue.shcap = (queue.shlen + w->sh_len) * 2;
                queue.sh = xrealloc(queue.sh, queue.shcap * sizeof *queue.sh);
            }
            memcpy(queue.sh + queue.shlen, w->sh, w->sh_len * sizeof *w->sh);
            queue.shlen += w->sh_len;
        }
        queue.pending = queue.pending + k + g - 1;
        bool done = queue.pending == 0;
        pthread_mutex_unlock(&queue.mu);
        if (shared) pthread_cond_broadcast(&queue.work_cv);
        if (g) pthread_cond_broadcast(&queue.gate_cv);
        if (done) {
            pthread_cond_broadcast(&queue.work_cv);
            pthread_cond_broadcast(&queue.gate_cv);
            pthread_cond_broadcast(&queue.done_cv);
        }
    }
    atomic_store(&w->alive, false);
    return NULL;
}

static void start_worker(int lane) {
    int i = atomic_load(&nthreads);
    worker *w = &workers[i];
    w->lane = lane;
    w->buf_size = 256 * 1024;
    w->buf = xmalloc(w->buf_size);
    atomic_store(&w->beat_ms, now_ms());
    atomic_store(&w->alive, true);
    pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 512 * 1024);
    if (pthread_create(&w->thread, &attr, worker_main, w) != 0) die("could not start threads");
    pthread_attr_destroy(&attr);
    atomic_store(&nthreads, i + 1);
}

static bool is_stuck(worker *w, uint64_t t) {
    return atomic_load(&w->alive) && atomic_load_explicit(&w->current, memory_order_acquire) &&
           since(t, atomic_load(&w->beat_ms)) > STUCK_MS;
}

// ---------------------------------------------------------------- sharing

static int by_key(const void *a, const void *b) {
    uint64_t x = ((const sighting *)a)->key, y = ((const sighting *)b)->key;
    return x < y ? -1 : x > y;
}

// Splits the bytes of each shared file evenly among every place that holds a
// name or a copy of it. During the scan the first place found carried all
// the bytes, and which place that was depends on thread timing; without
// this the same folder could be large in one scan and empty in the next.
// Runs after the workers have stopped.
static void share_evenly(void) {
    sighting *v = queue.sh;
    size_t n = queue.shlen;
    qsort(v, n, sizeof *v, by_key);
    for (size_t i = 0; i < n;) {
        size_t j = i;
        uint64_t data = 0; // every copy and name has the same allocated size
        for (; j < n && v[j].key == v[i].key; j++)
            if ((v[j].bits & SH_BYTES) > data) data = v[j].bits & SH_BYTES;
        double share = (double)data / (double)(j - i);
        for (size_t m = i; m < j; m++) {
            // Fractional bytes keep the split exact and the same from scan to scan.
            double was = (v[m].bits & SH_COUNTED) ? (double)(v[m].bits & SH_BYTES) : 0;
            double delta = share - was;
            if (delta == 0) continue;
            if (v[m].bits & SH_SMALL) v[m].at->small_bytes += delta;
            for (node *a = v[m].at; a; a = a->parent) a->share_adj += delta;
        }
        i = j;
    }
}

// ---------------------------------------------------------------- progress

typedef struct {
    node **v;
    size_t len, cap;
} nvec;

static void nv_push(nvec *v, node *n) {
    if (v->len == v->cap) {
        v->cap = v->cap ? v->cap * 2 : 64;
        v->v = xrealloc(v->v, v->cap * sizeof *v->v);
    }
    v->v[v->len++] = n;
}

static double size_of(node *n) { return (double)atomic_load_explicit(&n->size, memory_order_relaxed) + n->share_adj; }

static int by_size_desc(const void *a, const void *b) {
    node *x = *(node *const *)a, *y = *(node *const *)b;
    double sx = size_of(x), sy = size_of(y);
    if (sx != sy) return sx > sy ? -1 : 1;
    size_t n = x->name_len < y->name_len ? x->name_len : y->name_len;
    int c = memcmp(x->name, y->name, n);
    if (c) return c;
    return (int)x->name_len - (int)y->name_len;
}

static void children_sorted(node *n, nvec *out) {
    out->len = 0;
    for (node *c = atomic_load_explicit(&n->first_child, memory_order_acquire); c; c = c->next_sibling) nv_push(out, c);
    qsort(out->v, out->len, sizeof *out->v, by_size_desc);
}

static void json_live_node(sbuf *b, node *n, int depth) {
    sb_puts(b, "{\"name\":");
    sb_json_str(b, n->name, n->name_len);
    uint16_t flags = flags_of(n);
    sb_printf(b, ",\"size\":%.0f,\"flags\":%u", size_of(n), flags);
    if (depth > 0 && (flags & NF_DIR)) {
        nvec kids = {0};
        children_sorted(n, &kids);
        size_t limit = depth == 2 ? 24 : 12;
        sb_puts(b, ",\"children\":[");
        size_t shown = 0;
        for (size_t i = 0; i < kids.len && shown < limit; i++) {
            if (size_of(kids.v[i]) < 0.5) break;
            if (shown++) sb_put(b, ",", 1);
            json_live_node(b, kids.v[i], depth - 1);
        }
        sb_put(b, "]", 1);
        free(kids.v);
    }
    sb_put(b, "}", 1);
}

static void emit_progress(sbuf *b, bool with_tree) {
    sb_printf(b,
              "{\"type\":\"progress\",\"elapsed\":%.3f,\"files\":%u,\"dirs\":%u,\"bytes\":%.0f,\"nodes\":%u,"
              "\"locked\":%u,\"protected\":%u",
              now_s() - started_at, atomic_load(&top->files), atomic_load(&top->dirs),
              size_of(top), atomic_load(&node_count), atomic_load(&locked_count), atomic_load(&protected_count));
    uint64_t t = now_ms();
    int n = atomic_load(&nthreads);
    char path[PATH_MAX];
    for (int i = 0; i < n; i++) {
        node *c = atomic_load_explicit(&workers[i].current, memory_order_acquire);
        if (c && !is_stuck(&workers[i], t) && node_path(c, path, sizeof path) >= 0) {
            sb_puts(b, ",\"current\":");
            sb_json_str(b, path, strlen(path));
            break;
        }
    }
    // Folders that have not answered for a while: macOS waiting on a
    // permission prompt (with --protected ask), or a folder that hangs.
    int waiting = 0;
    for (int i = 0; i < n; i++) {
        node *c = atomic_load_explicit(&workers[i].current, memory_order_acquire);
        if (!c || !is_stuck(&workers[i], t) || node_path(c, path, sizeof path) < 0) continue;
        sb_puts(b, waiting++ ? "," : ",\"waiting\":[");
        sb_puts(b, "{\"path\":");
        sb_json_str(b, path, strlen(path));
        sb_printf(b, ",\"seconds\":%.1f}", (double)since(t, atomic_load(&workers[i].beat_ms)) / 1000.0);
    }
    if (waiting) sb_put(b, "]", 1);
    if (with_tree) {
        sb_puts(b, ",\"roots\":[");
        for (int i = 0; i < roots.count; i++) {
            if (i) sb_put(b, ",", 1);
            json_live_node(b, roots.node[i], 2);
        }
        sb_put(b, "]", 1);
    }
    sb_put(b, "}", 1);
    emit(b);
}

// ---------------------------------------------------------------- snapshot

static void write_all(FILE *f, const void *p, size_t n) {
    if (n && fwrite(p, 1, n, f) != n) die("could not write the snapshot");
}

static void write_aligned(FILE *f, const void *p, size_t n, long *off) {
    write_all(f, p, n);
    *off += (long)n;
    static const char zeros[8] = {0};
    size_t pad = (size_t)((8 - (*off % 8)) % 8);
    write_all(f, zeros, pad);
    *off += (long)pad;
}

// Snapshot layout (little-endian):
//   "SPWKSNAP" u32 version u32 header_len header_json pad8
//   u32 n u32 names_len
//   f64 size[n] f64 full[n] f64 priv[n] f64 small_bytes[n]
//   i32 parent[n] u32 span[n] u32 files[n] u32 dirs[n] u32 small_count[n]
//   u32 mtime[n] u32 mtime_max[n] u32 name_off[n]
//   u16 name_len[n] u16 flags[n] u8 err[n] u8 names[names_len]
// Each array starts on an 8-byte boundary. Nodes are in pre-order with
// children sorted largest first, so node i's subtree is [i, i + span[i]).
static void write_snapshot(double elapsed, uint32_t stalled) {
    uint32_t cap = atomic_load(&node_count);
    double *size = xmalloc(cap * sizeof *size);
    double *full = xmalloc(cap * sizeof *full);
    double *priv = xmalloc(cap * sizeof *priv);
    double *small_bytes = xmalloc(cap * sizeof *small_bytes);
    int32_t *parent = xmalloc(cap * sizeof *parent);
    uint32_t *span = xmalloc(cap * sizeof *span);
    uint32_t *files = xmalloc(cap * sizeof *files);
    uint32_t *dirs = xmalloc(cap * sizeof *dirs);
    uint32_t *small_count = xmalloc(cap * sizeof *small_count);
    uint32_t *mtime = xmalloc(cap * sizeof *mtime);
    uint32_t *mtime_max = xmalloc(cap * sizeof *mtime_max);
    uint32_t *name_off = xmalloc(cap * sizeof *name_off);
    uint16_t *name_len = xmalloc(cap * sizeof *name_len);
    uint16_t *flags = xmalloc(cap * sizeof *flags);
    uint8_t *errs = xmalloc(cap);
    sbuf names = {0};

    nvec stack = {0}, kids = {0};
    nv_push(&stack, top);
    uint32_t n = 0;
    while (stack.len && n < cap) {
        node *x = stack.v[--stack.len];
        uint32_t i = n++;
        x->out = i;
        size[i] = size_of(x);
        full[i] = (double)atomic_load(&x->full);
        priv[i] = (double)atomic_load(&x->priv);
        small_bytes[i] = x->small_bytes;
        parent[i] = x->parent ? (int32_t)x->parent->out : -1;
        span[i] = 1;
        files[i] = atomic_load(&x->files);
        dirs[i] = atomic_load(&x->dirs);
        small_count[i] = x->small_count;
        mtime[i] = x->mtime;
        mtime_max[i] = x->mtime;
        name_off[i] = (uint32_t)names.len;
        name_len[i] = x->name_len;
        flags[i] = flags_of(x);
        errs[i] = x->err;
        sb_put(&names, x->name, x->name_len);
        children_sorted(x, &kids);
        for (size_t k = kids.len; k > 0; k--) nv_push(&stack, kids.v[k - 1]);
    }
    for (uint32_t i = n; i-- > 1;) {
        uint32_t p = (uint32_t)parent[i];
        span[p] += span[i];
        if (mtime_max[i] > mtime_max[p]) mtime_max[p] = mtime_max[i];
    }

    sbuf h = {0};
    sb_printf(&h,
              "{\"version\":%d,\"createdAt\":%ld,\"elapsed\":%.3f,\"minFile\":%llu,\"threads\":%d,\"nodes\":%u,"
              "\"bytes\":%.0f,\"full\":%.0f,\"priv\":%.0f,\"linkedBytes\":%llu,\"clonedBytes\":%llu,\"files\":%u,\"dirs\":%u,"
              "\"locked\":%u,\"protected\":%u,\"errors\":%u,\"stalled\":%u",
              SNAPSHOT_VERSION, (long)started_wall, elapsed, (unsigned long long)min_file, atomic_load(&nthreads), n,
              size[0], full[0], priv[0], (unsigned long long)atomic_load(&linked_bytes),
              (unsigned long long)atomic_load(&cloned_bytes), files[0], dirs[0], atomic_load(&locked_count),
              atomic_load(&protected_count), atomic_load(&error_count), stalled);
    sb_access(&h);
    sb_puts(&h, ",\"roots\":[");
    for (int i = 0; i < roots.count; i++) {
        if (i) sb_put(&h, ",", 1);
        sb_puts(&h, "{\"name\":");
        sb_json_str(&h, roots.name[i], strlen(roots.name[i]));
        sb_puts(&h, ",\"path\":");
        sb_json_str(&h, roots.path[i], strlen(roots.path[i]));
        sb_printf(&h, ",\"index\":%u,\"fsid\":[%d,%d]}", roots.node[i]->out, roots.fsid[i].val[0],
                  roots.fsid[i].val[1]);
    }
    sb_puts(&h, "]}");

    char tmp[PATH_MAX];
    snprintf(tmp, sizeof tmp, "%s.partial", out_path);
    FILE *f = fopen(tmp, "wb");
    if (!f) die("could not create the snapshot file");
    long off = 0;
    uint32_t version = SNAPSHOT_VERSION, hlen = (uint32_t)h.len;
    write_all(f, "SPWKSNAP", 8);
    write_all(f, &version, 4);
    write_all(f, &hlen, 4);
    off = 16;
    write_aligned(f, h.p, h.len, &off);
    uint32_t counts[2] = {n, (uint32_t)names.len};
    write_aligned(f, counts, sizeof counts, &off);
    write_aligned(f, size, n * sizeof *size, &off);
    write_aligned(f, full, n * sizeof *full, &off);
    write_aligned(f, priv, n * sizeof *priv, &off);
    write_aligned(f, small_bytes, n * sizeof *small_bytes, &off);
    write_aligned(f, parent, n * sizeof *parent, &off);
    write_aligned(f, span, n * sizeof *span, &off);
    write_aligned(f, files, n * sizeof *files, &off);
    write_aligned(f, dirs, n * sizeof *dirs, &off);
    write_aligned(f, small_count, n * sizeof *small_count, &off);
    write_aligned(f, mtime, n * sizeof *mtime, &off);
    write_aligned(f, mtime_max, n * sizeof *mtime_max, &off);
    write_aligned(f, name_off, n * sizeof *name_off, &off);
    write_aligned(f, name_len, n * sizeof *name_len, &off);
    write_aligned(f, flags, n * sizeof *flags, &off);
    write_aligned(f, errs, n, &off);
    write_aligned(f, names.p, names.len, &off);
    if (fclose(f) != 0) die("could not finish the snapshot file");
    if (rename(tmp, out_path) != 0) die("could not move the snapshot into place");
}

// ---------------------------------------------------------------- main

static void usage(void) {
    fprintf(stderr,
            "usage: spacewalk-scan --out FILE [--threads N] [--min-file BYTES] [--interval MS]\n"
            "                      [--stall SECONDS] [--protected auto|ask|skip] [--skip PATH]...\n"
            "                      ROOT...\n"
            "ROOT is PATH or NAME=PATH. --skip names a folder to leave unopened, such as one\n"
            "that hung in an earlier scan. --protected decides what happens to folders that\n"
            "macOS guards with a permission prompt: auto (the default) opens them only when\n"
            "access is already granted, ask opens them and lets macOS ask on the Mac's\n"
            "screen, skip never opens them. Metadata only; file contents are never read.\n");
    exit(64);
}

static void add_root(const char *arg) {
    if (roots.count == MAX_ROOTS) die("too many roots");
    const char *eq = strchr(arg, '=');
    const char *path = arg;
    char *name = NULL;
    if (eq && memchr(arg, '/', (size_t)(eq - arg)) == NULL && eq[1] == '/') {
        name = strndup(arg, (size_t)(eq - arg));
        path = eq + 1;
    }
    char *p = strdup(path);
    size_t len = strlen(p);
    while (len > 1 && p[len - 1] == '/') p[--len] = 0;
    if (!name) {
        const char *slash = strrchr(p, '/');
        name = strdup(len == 1 ? "/" : slash ? slash + 1 : p);
    }
    int i = roots.count++;
    roots.path[i] = p;
    roots.name[i] = name;
}

// Stops the scan where it stands and marks every folder still waiting.
static uint32_t freeze(void) {
    uint32_t stalled = 0;
    atomic_store(&frozen, true);
    queue.stop = true;
    for (size_t i = 0; i < queue.len; i++, stalled++) set_flags(queue.items[i], NF_STALLED);
    for (size_t i = 0; i < queue.glen; i++, stalled++) set_flags(queue.gitems[i], NF_STALLED);
    int n = atomic_load(&nthreads);
    for (int i = 0; i < n; i++) {
        node *c = atomic_load(&workers[i].current);
        if (c && atomic_load(&workers[i].alive)) {
            set_flags(c, NF_STALLED);
            stalled++;
        }
    }
    pthread_cond_broadcast(&queue.work_cv);
    pthread_cond_broadcast(&queue.gate_cv);
    return stalled;
}

int main(int argc, char **argv) {
    signal(SIGPIPE, SIG_IGN);
    for (int i = 1; i < argc; i++) {
        const char *a = argv[i];
        if (strcmp(a, "--out") == 0 && i + 1 < argc) out_path = argv[++i];
        else if (strcmp(a, "--threads") == 0 && i + 1 < argc) nworkers = atoi(argv[++i]);
        else if (strcmp(a, "--min-file") == 0 && i + 1 < argc) min_file = strtoull(argv[++i], NULL, 10);
        else if (strcmp(a, "--interval") == 0 && i + 1 < argc) interval_ms = atoi(argv[++i]);
        else if (strcmp(a, "--stall") == 0 && i + 1 < argc) stall_seconds = atoi(argv[++i]);
        else if (strcmp(a, "--skip") == 0 && i + 1 < argc) path_set_add_both(&skips, argv[++i]);
        else if (strcmp(a, "--protected") == 0 && i + 1 < argc) {
            const char *m = argv[++i];
            protected_mode = -1;
            for (int k = 0; k < (int)(sizeof protected_name / sizeof protected_name[0]); k++)
                if (strcmp(m, protected_name[k]) == 0) protected_mode = k;
            if (protected_mode < 0) usage();
        } else if (strcmp(a, "--test-hang") == 0 && i + 1 < argc) test_hang = argv[++i];
        else if (a[0] == '-') usage();
        else add_root(a);
    }
    if (!out_path || roots.count == 0) usage();
    if (nworkers < 1) nworkers = 1;
    if (nworkers > 128) nworkers = 128;
    if (interval_ms < 50) interval_ms = 50;
    check_access();

    // Never download cloud placeholders (iCloud Drive, other file providers).
    setiopolicy_np(IOPOL_TYPE_VFS_MATERIALIZE_DATALESS_FILES, IOPOL_SCOPE_PROCESS, IOPOL_MATERIALIZE_DATALESS_FILES_OFF);

    memset(&bulk_attrs, 0, sizeof bulk_attrs);
    bulk_attrs.bitmapcount = ATTR_BIT_MAP_COUNT;
    bulk_attrs.commonattr = ATTR_CMN_RETURNED_ATTRS | ATTR_CMN_ERROR | ATTR_CMN_NAME | ATTR_CMN_OBJTYPE |
                            ATTR_CMN_MODTIME | ATTR_CMN_FLAGS | ATTR_CMN_FILEID;
    bulk_attrs.fileattr = ATTR_FILE_LINKCOUNT | ATTR_FILE_ALLOCSIZE;
    // With FSOPT_ATTR_CMN_EXTENDED the fork group carries extended attributes.
    // Private size is left out here: see private_size.
    bulk_attrs.forkattr = ATTR_CMNEXT_CLONEID | ATTR_CMNEXT_EXT_FLAGS;

    for (int i = 0; i < SEEN_STRIPES; i++) pthread_mutex_init(&seen[i].mu, NULL);
    load_mounts();

    started_at = now_s();
    started_wall = time(NULL);
    arena main_mem = {0};
    top = new_node(&main_mem, NULL, "", 0, NF_DIR);
    sbuf b = {0};

    queue.cap = 1024;
    queue.items = xmalloc(queue.cap * sizeof *queue.items);
    for (int i = 0; i < roots.count; i++) {
        node *r = new_node(&main_mem, top, roots.name[i], strlen(roots.name[i]), NF_DIR | NF_ROOT);
        r->vol = (uint8_t)i;
        roots.node[i] = r;
        publish_child(top, r);
        struct statfs sfs;
        struct stat st;
        if (statfs(roots.path[i], &sfs) != 0 || stat(roots.path[i], &st) != 0) {
            mark_unreadable(r, errno);
            continue;
        }
        roots.fsid[i] = sfs.f_fsid;
        r->mtime = st.st_mtimespec.tv_sec > 0 ? (uint32_t)st.st_mtimespec.tv_sec : 0;
        queue.items[queue.len++] = r;
        queue.pending++;
    }
    atomic_fetch_add(&top->dirs, (uint32_t)roots.count);

    sb_printf(&b, "{\"type\":\"start\",\"threads\":%d,\"minFile\":%llu,\"roots\":[", nworkers,
              (unsigned long long)min_file);
    for (int i = 0; i < roots.count; i++) {
        if (i) sb_put(&b, ",", 1);
        sb_puts(&b, "{\"name\":");
        sb_json_str(&b, roots.name[i], strlen(roots.name[i]));
        sb_puts(&b, ",\"path\":");
        sb_json_str(&b, roots.path[i], strlen(roots.path[i]));
        sb_put(&b, "}", 1);
    }
    sb_put(&b, "]", 1);
    sb_access(&b);
    sb_put(&b, "}", 1);
    emit(&b);

    workers = calloc((size_t)(nworkers + 1 + MAX_MAIN_SPARES + MAX_GATE_SPARES), sizeof *workers);
    if (!workers) die("out of memory");
    atomic_store(&heartbeat_ms, now_ms());
    for (int i = 0; i < nworkers; i++) start_worker(LANE_MAIN);
    start_worker(LANE_GATE);

    uint32_t stalled = 0;
    int main_spares = 0, gate_spares = 0;
    uint64_t only_stuck_since = 0;
    double last_tree = 0;
    pthread_mutex_lock(&queue.mu);
    while (queue.pending > 0) {
        struct timespec ts;
        clock_gettime(CLOCK_REALTIME, &ts);
        long ns = ts.tv_nsec + (long)interval_ms * 1000000L;
        ts.tv_sec += ns / 1000000000L;
        ts.tv_nsec = ns % 1000000000L;
        pthread_cond_timedwait(&queue.done_cv, &queue.mu, &ts);
        if (queue.pending == 0) break;
        pthread_mutex_unlock(&queue.mu);

        double now = now_s();
        bool with_tree = now - last_tree >= 0.5;
        if (with_tree) last_tree = now;
        emit_progress(&b, with_tree);

        uint64_t t = now_ms();
        int n = atomic_load(&nthreads), stuck = 0, free_main = 0, free_gate = 0;
        for (int i = 0; i < n; i++) {
            worker *w = &workers[i];
            if (!atomic_load(&w->alive)) continue;
            if (is_stuck(w, t)) stuck++;
            else if (w->lane == LANE_MAIN) free_main++;
            else free_gate++;
        }

        pthread_mutex_lock(&queue.mu);
        // Route around stuck folders: start a spare thread when a lane has
        // queued work but all of its threads are stuck.
        if (queue.glen > 0 && free_gate == 0 && gate_spares < MAX_GATE_SPARES) {
            start_worker(LANE_GATE);
            gate_spares++;
        }
        if (queue.len > 0 && free_main < nworkers && stuck > 0 && main_spares < MAX_MAIN_SPARES) {
            start_worker(LANE_MAIN);
            main_spares++;
        }
        // Finish when only stuck folders remain (after a grace period), or
        // when nothing at all has moved for stall_seconds.
        bool only_stuck = queue.len == 0 && queue.glen == 0 && queue.pending == (size_t)stuck;
        if (!only_stuck) only_stuck_since = 0;
        else if (!only_stuck_since) only_stuck_since = t;
        bool quiet = stall_seconds > 0 && since(t, atomic_load(&heartbeat_ms)) > (uint64_t)stall_seconds * 1000;
        if (queue.pending > 0 && ((only_stuck_since && since(t, only_stuck_since) > GRACE_MS) || quiet)) {
            stalled = freeze();
            break;
        }
    }
    pthread_mutex_unlock(&queue.mu);

    if (!stalled) {
        int n = atomic_load(&nthreads);
        for (int i = 0; i < n; i++) pthread_join(workers[i].thread, NULL);
    } else {
        // Give threads that are still moving a moment to notice the stop.
        // Threads blocked in the kernel cannot be joined and are left behind.
        for (int tries = 0; tries < 40; tries++) {
            uint64_t t = now_ms();
            int busy = 0, n = atomic_load(&nthreads);
            for (int i = 0; i < n; i++)
                if (atomic_load(&workers[i].alive) && !is_stuck(&workers[i], t)) busy++;
            if (!busy) break;
            usleep(10000);
        }
    }
    atomic_store(&frozen, true);

    share_evenly();
    double elapsed = now_s() - started_at;
    emit_progress(&b, true);
    write_snapshot(elapsed, stalled);
    sb_printf(&b,
              "{\"type\":\"done\",\"elapsed\":%.3f,\"files\":%u,\"dirs\":%u,\"bytes\":%.0f,\"full\":%llu,\"priv\":%llu,"
              "\"linkedBytes\":%llu,\"clonedBytes\":%llu,\"nodes\":%u,\"locked\":%u,\"protected\":%u,\"errors\":%u,"
              "\"stalled\":%u,\"out\":",
              elapsed, atomic_load(&top->files), atomic_load(&top->dirs), size_of(top),
              (unsigned long long)atomic_load(&top->full), (unsigned long long)atomic_load(&top->priv), (unsigned long long)atomic_load(&linked_bytes),
              (unsigned long long)atomic_load(&cloned_bytes), atomic_load(&node_count), atomic_load(&locked_count),
              atomic_load(&protected_count), atomic_load(&error_count), stalled);
    sb_json_str(&b, out_path, strlen(out_path));
    sb_put(&b, "}", 1);
    emit(&b);
    if (stalled) _exit(0); // threads blocked in the kernel cannot be joined
    return 0;
}
