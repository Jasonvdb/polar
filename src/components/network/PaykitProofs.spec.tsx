import React from 'react';
import { fireEvent } from '@testing-library/react';
import { newPaykitId, PaykitReceiverWorkspace } from 'shared/paykitApi';
import { renderWithProviders } from 'utils/tests';
import PaykitProofs from './PaykitProofs';
const receiverId = newPaykitId();
const requestId = newPaykitId();
const workspace: PaykitReceiverWorkspace = {
  receiverId,
  deliveryPaused: false,
  links: [],
  profiles: [],
  contacts: [],
  discoveries: [],
  requests: [
    {
      id: requestId,
      peerPublicKey: 'y'.repeat(52),
      peerReceiverPath: 'bob/wallet',
      role: 'payer',
      lifecycle: 'accepted',
      amountSats: '1000',
      description: 'A meal',
      paymentReference: 'reference',
      endpointBindings: [
        {
          source: 'private',
          method: 'btc-onchain',
          endpoint: 'bcrt1request',
          reservationId: newPaykitId(),
        },
      ],
      proposalExpiresAt: null,
      acceptedMethods: ['btc-onchain'],
      deliveryStatus: 'sent',
      createdAt: 'today',
    },
  ],
};
const setup = (current = workspace) => {
  const command = jest.fn();
  return {
    command,
    ...renderWithProviders(
      <PaykitProofs
        receiverId={receiverId}
        workspace={current}
        disabled={false}
        command={command}
      />,
    ),
  };
};
it('submits editable on-chain proof material independently of execution', () => {
  const view = setup();
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof request' }));
  fireEvent.click(view.getByText('A meal · 1000 sats'));
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof source' }));
  fireEvent.click(view.getByText('Enter proof manually'));
  fireEvent.change(view.getByLabelText('Proof transaction ID'), {
    target: { value: 'a'.repeat(64) },
  });
  fireEvent.change(view.getByLabelText('Proof output index'), { target: { value: '2' } });
  fireEvent.click(view.getByText('Submit payment proof'));
  expect(view.command).toHaveBeenCalledWith('proof.submit', {
    receiverId,
    requestId,
    proof: { method: 'btc-onchain', txid: 'a'.repeat(64), outputIndex: 2 },
  });
});
it('shows proof delivery separately from pending settlement and lets payee set confirmation depth', () => {
  const proofId = newPaykitId();
  const view = setup({
    ...workspace,
    requests: [{ ...workspace.requests![0], role: 'payee', lifecycle: 'proofSubmitted' }],
    proofs: [
      {
        id: proofId,
        requestId,
        method: 'btc-onchain',
        proof: { method: 'btc-onchain', txid: 'a'.repeat(64), outputIndex: 0 },
        deliveryStatus: 'received',
        recordedAt: 'today',
      },
    ],
    settlements: [
      {
        proofId,
        requestId,
        status: 'pending',
        confirmations: 0,
        requiredConfirmations: 1,
        verifiedAt: null,
        lastError: null,
      },
    ],
  });
  expect(view.getByText('received')).toBeInTheDocument();
  expect(view.getByText('pending')).toBeInTheDocument();
  expect(view.getByText('0 / 1')).toBeInTheDocument();
  fireEvent.change(view.getByLabelText('Required settlement confirmations'), {
    target: { value: '2' },
  });
  fireEvent.click(view.getByText('Verify settlement'));
  expect(view.command).toHaveBeenCalledWith('proof.verify', {
    receiverId,
    requestId,
    proofId,
    requiredConfirmations: 2,
  });
});
