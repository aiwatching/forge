import { auth } from '@/lib/auth';
import { redirect } from 'next/navigation';
import MobileView from '@/components/MobileView';

export default async function MobilePage() {
  const session = await auth();
  if (!session) redirect('/login');
  return <MobileView />;
}
