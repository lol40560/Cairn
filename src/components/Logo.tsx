interface LogoProps {
  size?: number
  className?: string
}

export function Logo({ size = 20, className }: LogoProps) {
  return (
    <svg
      aria-hidden="true"
      className={className}
      fill="none"
      height={size}
      viewBox="0 0 24 24"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g fill="#D15060" stroke="#D15060" strokeLinecap="round" strokeLinejoin="round" strokeWidth="0.8">
        <path d="M 9.5 8.2 L 14.8 6.5 L 17.2 8.5 L 17.5 10.3 L 14.5 11.6 L 10.2 11.5 L 8.2 10 Z" />
        <path d="M 7.8 10.5 L 9.8 9.6 L 10.6 11.3 L 10.1 13.8 L 8.6 14.6 L 7 13.2 L 6.6 11.5 Z" />
        <path d="M 9.5 14 L 15 13.8 L 17.8 15.8 L 16.8 18.2 L 10 18.5 L 8 17 Z" />
      </g>
      <circle cx="12.6" cy="9.2" r="0.55" fill="#17171A" />
      <circle cx="14.8" cy="9" r="0.55" fill="#17171A" />
    </svg>
  )
}
