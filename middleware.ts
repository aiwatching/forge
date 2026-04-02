import { NextResponse, type NextRequest } from 'next/server';

export function middleware(req: NextRequest) {
  // Skip auth entirely in dev mode
  const isDev = process.env.NODE_ENV !== 'production' || process.env.FORGE_DEV === '1';
  if (isDev) {
    return NextResponse.next();
  }

  const { pathname } = req.nextUrl;

  // Allow auth endpoints and static assets without login
  if (
    pathname.startsWith('/login') ||
    pathname.startsWith('/api/auth') ||
    pathname.startsWith('/api/telegram') ||
    (pathname.startsWith('/api/workspace') && (pathname.includes('/smith') || pathname === '/api/workspace')) ||
    pathname.startsWith('/_next') ||
    pathname === '/favicon.ico' ||
    pathname === '/icon.png'
  ) {
    return NextResponse.next();
  }

  // Check for NextAuth session cookie (browser login)
  const hasSession =
    req.cookies.has('authjs.session-token') ||
    req.cookies.has('__Secure-authjs.session-token');

  if (hasSession) {
    return NextResponse.next();
  }

  // Check for Forge API token (Help AI / CLI tools)
  // Token obtained via POST /api/auth/verify with admin password
  const forgeToken = req.headers.get('x-forge-token') || req.cookies.get('forge-api-token')?.value;
  if (forgeToken) {
    // Token validation happens in API route layer via isValidToken()
    // Middleware passes it through — only localhost can obtain tokens
    return NextResponse.next();
  }

  if (pathname.startsWith('/api/')) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
