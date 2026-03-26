import { headers } from 'next/headers';
import LoginForm from './LoginForm';

export default async function LoginPage() {
  const headersList = await headers();
  const host = headersList.get('host') || '';
  const isRemote = host.endsWith('.trycloudflare.com');

  return <LoginForm isRemote={isRemote} />;
}
