import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import MobileView from '@/components/MobileView';

export default async function MobilePage() {
  const isDev = process.env.NODE_ENV !== 'production' || process.env.FORGE_DEV === '1';
  const session = isDev ? { user: { name: 'Dev', email: 'dev@forge' } } : await auth();
  if (!session) redirect('/login');
  return <MobileView />;
}
