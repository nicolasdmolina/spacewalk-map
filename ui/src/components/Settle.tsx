// A number that settles into its new value: each digit rolls on its own reel,
// the last digit first, so a changing size reads as a change and not a flicker.

const DIGITS = '0123456789';

export function Settle({ text, className }: { text: string; className?: string }) {
  const chars = [...text];
  return (
    <span className={`settle${className ? ` ${className}` : ''}`}>
      <span className="sr-only">{text}</span>
      <span className="settle-reels" aria-hidden>
        {chars.map((ch, i) => {
          const fromEnd = chars.length - 1 - i;
          const d = DIGITS.indexOf(ch);
          if (d < 0)
            return (
              <span key={`c${fromEnd}`} className="settle-char">
                {ch}
              </span>
            );
          return (
            <span key={`d${fromEnd}`} className="reel">
              <span className="reel-ghost">0</span>
              <span
                className="reel-strip"
                style={{ transform: `translateY(${-d * 10}%)`, transitionDelay: `${fromEnd * 18}ms` }}
              >
                {DIGITS.split('').map((x) => (
                  <span key={x}>{x}</span>
                ))}
              </span>
            </span>
          );
        })}
      </span>
    </span>
  );
}
