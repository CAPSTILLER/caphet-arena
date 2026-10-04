/** The parts of contracts/src/GameRecords.sol this server uses. Keep in step with the contract. */
export const gameRecordsAbi = [
  {
    type: 'function',
    name: 'recordRound',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'roundId', type: 'bytes32' },
      { name: 'wallet', type: 'address' },
      { name: 'mode', type: 'uint8' },
      { name: 'outcome', type: 'uint8' },
      { name: 'score', type: 'uint32' },
      { name: 'volumeBucket', type: 'uint16' },
      { name: 'seedCommit', type: 'bytes32' },
      { name: 'movesHash', type: 'bytes32' },
    ],
    outputs: [],
  },
  { type: 'function', name: 'isRecorded', stateMutability: 'view', inputs: [{ name: 'roundId', type: 'bytes32' }], outputs: [{ name: '', type: 'bool' }] },
  { type: 'function', name: 'bestScore', stateMutability: 'view', inputs: [{ name: 'wallet', type: 'address' }, { name: 'mode', type: 'uint8' }], outputs: [{ name: '', type: 'uint32' }] },
] as const;
