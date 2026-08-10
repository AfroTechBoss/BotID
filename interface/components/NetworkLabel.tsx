'use client';
import { useNetwork } from '@/lib/network';

// Deliberately tiny, and deliberately the only client component in the footer: the footer is a
// list of links that never change, and making the whole thing a client component to print one
// word would ship the rest of it to the browser for nothing.
export default function NetworkLabel({ form = 'short' }: { form?: 'short' | 'name' }) {
  const { network } = useNetwork();
  return <>{form === 'name' ? network.name : network.short}</>;
}
