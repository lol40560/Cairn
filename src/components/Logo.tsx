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
      <path
        d="M12 5.25L5.5 18H18.5L12 5.25Z"
        stroke="#5B7C99"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.45"
      />
      <circle cx="12" cy="5.25" r="1.2" fill="#5B7C99" />
      <circle cx="5.5" cy="18" r="1.2" fill="#5B7C99" />
      <circle cx="18.5" cy="18" r="1.2" fill="#5B7C99" />
      <circle cx="12" cy="13.1" r="1.35" fill="#E07B39" />
    </svg>
  )
}
