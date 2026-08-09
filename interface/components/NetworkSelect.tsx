'use client';
import { useState } from 'react';

export default function NetworkSelect() {
  const [network, setNetwork] = useState<'testnet' | 'mainnet'>('testnet');
  return (
    <select
      className="btn btn-secondary"
      value={network}
      onChange={(e) => setNetwork(e.target.value as 'testnet' | 'mainnet')}
      style={{
        appearance: 'none', WebkitAppearance: 'none', width: 'auto', fontSize: 11, padding: '6px 26px 6px 10px',
        backgroundImage:
          'linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%)',
        backgroundPosition: 'calc(100% - 14px) 55%, calc(100% - 9px) 55%',
        backgroundSize: '5px 5px, 5px 5px', backgroundRepeat: 'no-repeat',
      }}
    >
      <option value="testnet">Bohr Testnet</option>
      <option value="mainnet">BOT Chain</option>
    </select>
  );
}
