import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import Dashboard from '@/components/Dashboard';

export default async function Home() {
  const session = await auth();
  if (!session) redirect('/login');

  // Auto-detect mobile and redirect
  const headersList = await headers();
  const ua = headersList.get('user-agent') || '';
  const isMobile = /iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
  if (isMobile) redirect('/mobile');

  return <Dashboard user={session.user} />;
}
