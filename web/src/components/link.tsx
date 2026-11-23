import type { AnchorHTMLAttributes, ReactNode } from 'react';
import { linkTo } from '../lib/router';

export function Link({
  to,
  children,
  className,
  ...rest
}: {
  to: string;
  children: ReactNode;
  className?: string;
} & Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'>) {
  return (
    <a href={linkTo(to)} className={className} {...rest}>
      {children}
    </a>
  );
}
