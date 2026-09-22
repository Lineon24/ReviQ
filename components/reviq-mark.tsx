import type { SVGProps } from "react";

/** The Q tail suggests a conversation; the two lines represent a review. */
export function ReviQMark({ size = 32, ...props }: SVGProps<SVGSVGElement> & { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true" {...props}>
      <rect width="64" height="64" rx="18" fill="currentColor" />
      <circle cx="30" cy="29" r="17" stroke="white" strokeWidth="4.5" />
      <path d="m40 40 10 10" stroke="white" strokeWidth="5" strokeLinecap="round" />
      <path d="M23 25h14M23 33h9" stroke="white" strokeWidth="3.5" strokeLinecap="round" />
    </svg>
  );
}
