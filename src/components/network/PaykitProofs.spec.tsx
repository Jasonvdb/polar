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

it('keeps proposed requests ineligible until acceptance and then submits an accepted-rail proof', () => {
  const command = jest.fn();
  const Harness = () => {
    const [accepted, setAccepted] = React.useState(false);
    return (
      <>
        <button onClick={() => setAccepted(true)}>Observe accepted request</button>
        <PaykitProofs
          receiverId={receiverId}
          workspace={{
            ...workspace,
            requests: [
              {
                ...workspace.requests![0],
                lifecycle: accepted ? 'accepted' : 'proposed',
              },
            ],
          }}
          disabled={false}
          command={command}
        />
      </>
    );
  };
  const view = renderWithProviders(<Harness />);
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof request' }));
  expect(view.queryByText('A meal · 1000 sats')).not.toBeInTheDocument();
  expect(view.getByText('Submit payment proof').closest('button')).toBeDisabled();
  fireEvent.click(view.getByText('Observe accepted request'));
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof request' }));
  fireEvent.click(view.getByText('A meal · 1000 sats'));
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof source' }));
  fireEvent.click(view.getByText('Enter proof manually'));
  fireEvent.change(view.getByLabelText('Proof transaction ID'), {
    target: { value: 'c'.repeat(64) },
  });
  fireEvent.click(view.getByText('Submit payment proof'));
  expect(command).toHaveBeenCalledTimes(1);
  expect(command).toHaveBeenCalledWith('proof.submit', {
    receiverId,
    requestId,
    proof: { method: 'btc-onchain', txid: 'c'.repeat(64), outputIndex: 0 },
  });
});
it('restricts manual proof methods to accepted rails and resets rail selection for another request', () => {
  const lightningId = newPaykitId();
  const view = setup({
    ...workspace,
    requests: [
      ...workspace.requests!,
      {
        ...workspace.requests![0],
        id: lightningId,
        description: 'Lightning meal',
        acceptedMethods: ['btc-lightning-bolt11'],
      },
    ],
  });
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof request' }));
  fireEvent.click(view.getByText('A meal · 1000 sats'));
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof source' }));
  fireEvent.click(view.getByText('Enter proof manually'));
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof method' }));
  expect(view.queryByText('btc-lightning-bolt11')).not.toBeInTheDocument();
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof request' }));
  fireEvent.click(view.getByText('Lightning meal · 1000 sats'));
  expect(view.queryByLabelText('Proof transaction ID')).not.toBeInTheDocument();
  fireEvent.change(view.getByLabelText('Proof payment hash'), {
    target: { value: 'd'.repeat(64) },
  });
  fireEvent.change(view.getByLabelText('Proof preimage'), {
    target: { value: 'e'.repeat(64) },
  });
  fireEvent.click(view.getByText('Submit payment proof'));
  expect(view.command).toHaveBeenCalledWith('proof.submit', {
    receiverId,
    requestId: lightningId,
    proof: {
      method: 'btc-lightning-bolt11',
      paymentHash: 'd'.repeat(64),
      preimage: 'e'.repeat(64),
    },
  });
});
it('blocks a previously selected proof after cancellation or while command acceptance is uncertain', () => {
  const command = jest.fn();
  const Harness = () => {
    const [canceled, cancel] = React.useState(false);
    const [uncertain, setUncertain] = React.useState(false);
    return (
      <>
        <button
          onClick={() => {
            cancel(true);
            setUncertain(false);
          }}
        >
          Observe cancellation
        </button>
        <button onClick={() => setUncertain(true)}>Observe uncertain command</button>
        <PaykitProofs
          receiverId={receiverId}
          workspace={{
            ...workspace,
            requests: [
              {
                ...workspace.requests![0],
                lifecycle: canceled ? 'canceled' : 'accepted',
              },
            ],
          }}
          disabled={uncertain}
          command={command}
        />
      </>
    );
  };
  const view = renderWithProviders(<Harness />);
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof request' }));
  fireEvent.click(view.getByText('A meal · 1000 sats'));
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof source' }));
  fireEvent.click(view.getByText('Enter proof manually'));
  fireEvent.change(view.getByLabelText('Proof transaction ID'), {
    target: { value: 'c'.repeat(64) },
  });
  const submit = view.getByText('Submit payment proof').closest('button')!;
  expect(submit).not.toBeDisabled();
  fireEvent.click(view.getByText('Observe uncertain command'));
  expect(submit).toBeDisabled();
  fireEvent.click(submit);
  expect(command).not.toHaveBeenCalled();
  fireEvent.click(view.getByText('Observe cancellation'));
  expect(submit).toBeDisabled();
});
it('offers only successful accepted-rail executions and submits the prepared proof identity', () => {
  const wrongId = newPaykitId();
  const correctId = newPaykitId();
  const execution = {
    id: wrongId,
    requestId,
    walletId: 'wallet',
    source: 'private' as const,
    method: 'btc-lightning-bolt11',
    endpoint: 'lnbcrt1example',
    amountSats: '1000',
    status: 'succeeded' as const,
    createdAt: 'today',
    updatedAt: 'today',
    txid: null,
    outputIndex: null,
    paymentHash: 'a'.repeat(64),
    lastError: null,
  };
  const view = setup({
    ...workspace,
    executions: [
      execution,
      { ...execution, id: correctId, method: 'btc-onchain', endpoint: 'bcrt1request' },
    ],
  });
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof request' }));
  fireEvent.click(view.getByText('A meal · 1000 sats'));
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof execution' }));
  expect(view.queryByText(`${wrongId} · btc-lightning-bolt11`)).not.toBeInTheDocument();
  expect(view.getByText('Submit payment proof').closest('button')).toBeDisabled();
  fireEvent.click(view.getByText(`${correctId} · btc-onchain`));
  fireEvent.click(view.getByText('Submit payment proof'));
  expect(view.command).toHaveBeenCalledWith('proof.submit', {
    receiverId,
    requestId,
    executionId: correctId,
  });
});

it('submits a raw recurring proof for an explicitly entered billing period', () => {
  const view = setup({
    ...workspace,
    requests: [
      {
        ...workspace.requests![0],
        lifecycle: 'activeRecurring',
        recurrence: {
          every: 1,
          unit: 'month',
          startsAt: '2099-01-31T00:00:00Z',
          anchor: '2099-01-31T00:00:00Z',
          endsAt: null,
        },
      },
    ],
  });
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof request' }));
  fireEvent.click(view.getByText('A meal · 1000 sats'));
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Proof source' }));
  fireEvent.click(view.getByText('Enter proof manually'));
  fireEvent.change(view.getByLabelText('Proof billing period index'), {
    target: { value: '2' },
  });
  fireEvent.change(view.getByLabelText('Proof transaction ID'), {
    target: { value: 'a'.repeat(64) },
  });
  fireEvent.click(view.getByText('Submit payment proof'));
  expect(view.command).toHaveBeenCalledWith('proof.submit', {
    receiverId,
    requestId,
    periodIndex: 2,
    proof: { method: 'btc-onchain', txid: 'a'.repeat(64), outputIndex: 0 },
  });
});
