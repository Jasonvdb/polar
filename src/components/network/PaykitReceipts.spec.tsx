import React from 'react';
import { fireEvent } from '@testing-library/react';
import {
  newPaykitId,
  PaykitReceiverWorkspace,
  PaykitReceiptIssuance,
} from 'shared/paykitApi';
import { renderWithProviders } from 'utils/tests';
import PaykitReceipts from './PaykitReceipts';

const receiverId = newPaykitId();
const requestId = newPaykitId();
const proofId = newPaykitId();
const receiptId = newPaykitId();
const peerPublicKey = 'y'.repeat(52);
const now = '2026-09-11T00:00:00Z';
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
      peerPublicKey,
      peerReceiverPath: 'alice/wallet',
      role: 'payee',
      lifecycle: 'proofSubmitted',
      amountSats: '1000',
      description: 'A meal',
      paymentReference: 'reference',
      endpointBindings: [],
      proposalExpiresAt: null,
      acceptedMethods: ['btc-onchain'],
      deliveryStatus: 'sent',
      createdAt: now,
    },
  ],
  proofs: [
    {
      id: proofId,
      requestId,
      method: 'btc-onchain',
      proof: { method: 'btc-onchain', txid: 'a'.repeat(64), outputIndex: 0 },
      deliveryStatus: 'received',
      recordedAt: now,
    },
  ],
  settlements: [
    {
      proofId,
      requestId,
      status: 'verified',
      requiredConfirmations: 1,
      confirmations: 1,
      verifiedAt: now,
      lastError: null,
    },
  ],
};
const issuance: PaykitReceiptIssuance = {
  id: receiptId,
  requestId,
  proofId,
  peerPublicKey,
  peerReceiverPath: 'alice/wallet',
  paymentReference: 'reference',
  method: 'btc-onchain',
  amountSats: '1000',
  description: 'A meal',
  note: 'Original note',
  status: 'pendingStorage',
  deliveryStatus: 'notQueued',
  accessEventId: newPaykitId(),
  outboundMessageId: null,
  createdAt: now,
  updatedAt: now,
  storedAt: null,
  accessQueuedAt: null,
  lastError: null,
};
const setup = (current = workspace, disabled = false) => {
  const command = jest.fn().mockResolvedValue(undefined);
  return {
    command,
    ...renderWithProviders(
      <PaykitReceipts
        receiverId={receiverId}
        workspace={current}
        disabled={disabled}
        command={command}
      />,
    ),
  };
};
const selectProof = (view: ReturnType<typeof setup>) => {
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Receipt verified proof' }));
  fireEvent.click(view.getByText(`A meal · 1000 sats · btc-onchain · ${proofId}`));
};
it('prepares the exact verified proof with untrimmed bounded note and no editable payment terms', () => {
  const view = setup();
  selectProof(view);
  fireEvent.change(view.getByLabelText('Receipt note'), {
    target: { value: '  Thank you  ' },
  });
  fireEvent.click(view.getByText('Prepare receipt'));
  expect(view.command).toHaveBeenCalledWith('receipt.prepare', {
    receiverId,
    requestId,
    proofId,
    note: '  Thank you  ',
  });
  expect(view.queryByLabelText('Receipt amount')).not.toBeInTheDocument();
  fireEvent.change(view.getByLabelText('Receipt note'), {
    target: { value: 'é'.repeat(251) },
  });
  expect(view.getByText('Prepare receipt').closest('button')).toBeDisabled();
  expect(
    view.getByText(
      'Receipt note must be at most 500 UTF-8 bytes without control characters.',
    ),
  ).toBeInTheDocument();
});
it.each(['pending', 'invalid', 'failed'] as const)(
  'does not offer a %s settlement for preparation',
  status => {
    const view = setup({
      ...workspace,
      settlements: [{ ...workspace.settlements![0], status }],
    });
    fireEvent.mouseDown(view.getByRole('combobox', { name: 'Receipt verified proof' }));
    expect(
      view.queryByText(`A meal · 1000 sats · btc-onchain · ${proofId}`),
    ).not.toBeInTheDocument();
    expect(view.getByText('Prepare receipt').closest('button')).toBeDisabled();
  },
);
it('requires the payee, recorded verification time, and the exact request/proof relationship', () => {
  for (const current of [
    { ...workspace, requests: [{ ...workspace.requests![0], role: 'payer' as const }] },
    { ...workspace, settlements: [{ ...workspace.settlements![0], verifiedAt: null }] },
    { ...workspace, proofs: [{ ...workspace.proofs![0], requestId: newPaykitId() }] },
  ]) {
    const view = setup(current);
    fireEvent.mouseDown(view.getByRole('combobox', { name: 'Receipt verified proof' }));
    expect(
      view.queryByText(`A meal · 1000 sats · btc-onchain · ${proofId}`),
    ).not.toBeInTheDocument();
    view.unmount();
  }
});
it('keeps the original prepared note immutable and resumes the stable receipt identity', () => {
  const view = setup({
    ...workspace,
    receiptIssuances: [
      { ...issuance, status: 'failed', lastError: 'Receipt storage unavailable.' },
    ],
  });
  selectProof(view);
  expect(view.getByLabelText('Receipt note')).toHaveValue('Original note');
  expect(view.getByLabelText('Receipt note')).toBeDisabled();
  expect(view.getByText('Prepare receipt').closest('button')).toBeDisabled();
  expect(view.getByText('Receipt storage unavailable.')).toBeInTheDocument();
  expect(view.getByText('failed')).toBeInTheDocument();
  expect(view.getByText('notQueued')).toBeInTheDocument();
  fireEvent.click(view.getByRole('button', { name: `Process receipt ${receiptId}` }));
  expect(view.command).toHaveBeenCalledWith('receipt.process', { receiverId, receiptId });
});
it('retrieves the selected issuer namespace and shows failed decryption separately from sent access', () => {
  const view = setup({
    ...workspace,
    receiptIssuances: [{ ...issuance, status: 'accessQueued', deliveryStatus: 'sent' }],
    receiptAccess: ['bob/wallet', 'bob/server'].map(peerReceiverPath => ({
      receiptId,
      peerPublicKey,
      peerReceiverPath,
      accessEventId: newPaykitId(),
      requestId,
      paymentReference: 'reference',
      retrievalStatus: 'failed' as const,
      receivedAt: now,
      attemptedAt: now,
      retrievedAt: null,
      lastError: 'Receipt retrieval or decryption failed.',
    })),
    receipts: [
      {
        id: receiptId,
        issuerPublicKey: peerPublicKey,
        issuerReceiverPath: 'carol/wallet',
        recipientPublicKey: 'o'.repeat(52),
        requestId: null,
        proofId: null,
        paymentReference: 'foreign reference',
        method: null,
        amountSats: null,
        description: null,
        note: null,
        accessEventId: newPaykitId(),
        retrievedAt: now,
      },
    ],
  });
  expect(view.getByText('sent')).toBeInTheDocument();
  expect(view.getAllByText('Receipt retrieval or decryption failed.')).toHaveLength(2);
  expect(view.getAllByText('Not supplied or unsupported')).toHaveLength(2);
  expect(
    view.queryByRole('button', { name: `Process receipt ${receiptId}` }),
  ).not.toBeInTheDocument();
  fireEvent.click(
    view.getByRole('button', {
      name: `Retrieve receipt ${receiptId} from ${peerPublicKey} / bob/server`,
    }),
  );
  expect(view.command).toHaveBeenCalledWith('receipt.retrieve', {
    receiverId,
    receiptId,
    peerPublicKey,
    peerReceiverPath: 'bob/server',
  });
});
it('disables receipt actions while command submission or an operation is pending', () => {
  const view = setup({ ...workspace, receiptIssuances: [issuance] }, true);
  expect(
    view.getByRole('button', { name: `Process receipt ${receiptId}` }),
  ).toBeDisabled();
  expect(view.getByText('Prepare receipt').closest('button')).toBeDisabled();
  fireEvent.click(view.getByRole('button', { name: `Process receipt ${receiptId}` }));
  expect(view.command).not.toHaveBeenCalled();
});

it('shows a known-request mismatch without inventing decrypted receipt history', () => {
  const view = setup({
    ...workspace,
    receiptAccess: [
      {
        receiptId,
        peerPublicKey,
        peerReceiverPath: 'bob/server',
        accessEventId: newPaykitId(),
        requestId,
        paymentReference: 'reference',
        retrievalStatus: 'failed',
        receivedAt: now,
        attemptedAt: now,
        retrievedAt: null,
        lastError: 'Receipt does not match the known request.',
      },
    ],
    receipts: [],
  });
  expect(view.getByText('Receipt does not match the known request.')).toBeInTheDocument();
  expect(view.getByText('No decrypted receipts')).toBeInTheDocument();
  expect(
    view.getByText('Retry retrieval and decryption').closest('button'),
  ).not.toBeDisabled();
});
