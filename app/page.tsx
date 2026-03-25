import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import { headers } from 'next/headers';
import DashboardWrapper from '@/components/DashboardWrapper';

export default async function Home({ searchParams }: { searchParams: Promise<{ force?: string }> }) {
  const session = await auth();
  if (!session) redirect('/login');

  const params = await searchParams;

  // Auto-detect mobile and redirect (skip if ?force=desktop)
  if (params.force !== 'desktop') {
    const headersList = await headers();
    const ua = headersList.get('user-agent') || '';
    const isMobile = /iPhone|iPad|iPod|Android|webOS|BlackBerry|IEMobile|Opera Mini/i.test(ua);
    if (isMobile) redirect('/mobile');
  }

  return <DashboardWrapper user={session.user} />;
}
