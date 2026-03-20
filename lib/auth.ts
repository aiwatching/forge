import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import Credentials from 'next-auth/providers/credentials';
import { randomBytes } from 'node:crypto';

// Ensure AUTH_SECRET exists before NextAuth initializes
if (!process.env.AUTH_SECRET) {
  process.env.AUTH_SECRET = randomBytes(32).toString('hex');
}

export const { handlers, signIn, signOut, auth } = NextAuth({
  trustHost: true,
  logger: {
    error: () => {},  // Suppress noisy CredentialsSignin stack traces
  },
  providers: [
    // Google OAuth — for production use
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    }),
    // Local: admin password only
    // Remote (tunnel): admin password + session code (2FA)
    Credentials({
      name: 'Local',
      credentials: {
        password: { label: 'Password', type: 'password' },
        sessionCode: { label: 'Session Code', type: 'text' },
        isRemote: { label: 'Remote', type: 'text' },
      },
      async authorize(credentials) {
        const { verifyLogin } = await import('./password');
        const password = (credentials?.password ?? '') as string;
        const sessionCode = (credentials?.sessionCode ?? '') as string;
        const isRemote = String(credentials?.isRemote) === 'true';

        if (verifyLogin(password, sessionCode, isRemote)) {
          const { loadSettings } = await import('./settings');
          const settings = loadSettings();
          return { id: 'local', name: settings.displayName || 'Forge', email: settings.displayEmail || 'local@forge' };
        }
        return null;
      },
    }),
  ],
  pages: {
    signIn: '/login',
  },
  callbacks: {
    authorized({ auth }) {
      return !!auth;
    },
    redirect({ url, baseUrl }) {
      if (url.startsWith(baseUrl)) return url;
      if (url.startsWith('/')) return `${baseUrl}${url}`;
      if (url.includes('.trycloudflare.com')) return url;
      return baseUrl;
    },
  },
});
