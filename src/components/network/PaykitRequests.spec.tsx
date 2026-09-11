import React from 'react';
import { fireEvent } from '@testing-library/react';
import { newPaykitId, PaykitReceiverWorkspace, PaykitState } from 'shared/paykitApi';
import { renderWithProviders } from 'utils/tests';
import PaykitRequests from './PaykitRequests';

const receiverId = newPaykitId();
const requestId = newPaykitId();
const workspace: PaykitReceiverWorkspace = {
  receiverId,
  deliveryPaused: false,
  links: [],
  profiles: [],
  contacts: [],
  discoveries: [],
  paymentMethods: {
    enabledMethods: ['btc-onchain'],
    preference: [],
    wallets: [
      {
        id: 'wallet',
        label: 'Alice wallet',
        supportedMethods: ['btc-onchain'],
        status: 'configured',
      },
    ],
  },
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
      createdAt: '2026-01-01',
    },
  ],
};
const state: PaykitState = {
  apiVersion: 1,
  environmentId: newPaykitId(),
  ready: true,
  lastEventSequence: 0,
  participants: [],
  receivers: [],
  operations: [],
};
const setup = (current = workspace) => {
  const command = jest.fn();
  return {
    command,
    ...renderWithProviders(
      <PaykitRequests
        receiverId={receiverId}
        workspace={current}
        state={state}
        disabled={false}
        command={command}
      />,
    ),
  };
};
it('requires explicit source, wallet and method, then submits immutable accepted request identity', () => {
  const view = setup();
  const pay = view.getByText('Pay accepted request').closest('button')!;
  expect(pay).toBeDisabled();
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Payment request' }));
  fireEvent.click(view.getByText('A meal · 1000 sats · accepted'));
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Spending wallet' }));
  fireEvent.click(view.getByText('Alice wallet'));
  expect(pay).toBeDisabled();
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Payment endpoint source' }));
  fireEvent.click(view.getByText('Public'));
  expect(
    view.getByText(
      'This request has no public endpoint binding. Choose a source listed in its immutable receiving endpoints.',
    ),
  ).toBeInTheDocument();
  expect(pay).toBeDisabled();
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Payment endpoint source' }));
  fireEvent.click(view.getByText('Private'));
  expect(pay).toBeDisabled();
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Payment method' }));
  fireEvent.click(view.getAllByText('btc-onchain').slice(-1)[0]);
  expect(pay).not.toBeDisabled();
  fireEvent.click(pay);
  expect(view.command).toHaveBeenCalledWith('payment.execute', {
    receiverId,
    requestId,
    walletId: 'wallet',
    source: 'private',
    method: 'btc-onchain',
  });
});
it('blocks another payment after an uncertain execution and reconciles its original ID', () => {
  const execution = {
    id: newPaykitId(),
    requestId,
    walletId: 'wallet',
    source: 'private' as const,
    method: 'btc-onchain',
    endpoint: 'bcrt1public',
    amountSats: '1000',
    status: 'uncertain' as const,
    createdAt: 'today',
    updatedAt: 'today',
    txid: null,
    outputIndex: null,
    paymentHash: null,
    lastError: 'Outcome unknown',
  };
  const view = setup({ ...workspace, executions: [execution] });
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Payment request' }));
  fireEvent.click(view.getByText('A meal · 1000 sats · accepted'));
  expect(
    view.getByText(
      'This request already has an execution. Inspect or reconcile that execution before taking further action.',
    ),
  ).toBeInTheDocument();
  expect(view.getByText('Pay accepted request').closest('button')).toBeDisabled();
  fireEvent.click(view.getByText('Reconcile execution'));
  expect(view.command).toHaveBeenCalledWith('payment.reconcile', {
    receiverId,
    executionId: execution.id,
  });
});
it('composes exact satoshi text and applies lifecycle actions to the selected receiver', () => {
  const view = setup({
    ...workspace,
    requests: [{ ...workspace.requests![0], lifecycle: 'proposed' }],
    reservations: [
      {
        id: newPaykitId(),
        listId: newPaykitId(),
        walletId: 'wallet',
        source: 'public',
        method: 'btc-onchain',
        endpoint: 'bcrt1fresh',
        amountSats: '2100000000000000',
        createdAt: '2026-01-01',
        expiresAt: '2099-01-01',
        status: 'active',
        deliveryStatus: 'published',
        cleanupStatus: 'notRequired',
      },
    ],
  });
  fireEvent.change(view.getByLabelText('Request payer public key'), {
    target: { value: 'y'.repeat(52) },
  });
  fireEvent.change(view.getByLabelText('Request payer receiver path'), {
    target: { value: 'alice/wallet' },
  });
  fireEvent.change(view.getByLabelText('Request amount sats'), {
    target: { value: '2100000000000000' },
  });
  fireEvent.change(view.getByLabelText('Request description'), {
    target: { value: 'Editable terms' },
  });
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Request accepted methods' }));
  fireEvent.click(view.getAllByText('btc-onchain').slice(-1)[0]);
  fireEvent.click(view.getByText('Create payment request'));
  expect(view.command).toHaveBeenLastCalledWith('request.create', {
    receiverId,
    peerPublicKey: 'y'.repeat(52),
    peerReceiverPath: 'alice/wallet',
    amountSats: '2100000000000000',
    description: 'Editable terms',
    expirySeconds: 3600,
    acceptedMethods: ['btc-onchain'],
  });
  fireEvent.click(view.getByText('Accept request'));
  expect(view.command).toHaveBeenLastCalledWith('request.accept', {
    receiverId,
    requestId,
  });
  fireEvent.click(view.getByText('Reject request'));
  expect(view.command).toHaveBeenLastCalledWith('request.reject', {
    receiverId,
    requestId,
  });
});

it('shows immutable endpoint bindings and blocks proposals until fresh matching endpoints exist', () => {
  const view = setup();
  expect(view.getByText('bcrt1request')).toBeInTheDocument();
  expect(
    view.getByText(
      `Reservation ${workspace.requests![0].endpointBindings[0].reservationId}`,
    ),
  ).toBeInTheDocument();
  fireEvent.change(view.getByLabelText('Request payer public key'), {
    target: { value: 'y'.repeat(52) },
  });
  fireEvent.change(view.getByLabelText('Request payer receiver path'), {
    target: { value: 'bob/wallet' },
  });
  fireEvent.change(view.getByLabelText('Request description'), {
    target: { value: 'Fresh request' },
  });
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Request accepted methods' }));
  fireEvent.click(view.getAllByText('btc-onchain').slice(-1)[0]);
  expect(
    view.getByText(
      'Publish or rotate fresh receiving endpoints for: btc-onchain (1000 sats). Use Payment methods and reservations above.',
    ),
  ).toBeInTheDocument();
  expect(view.getByText('Create payment request').closest('button')).toBeDisabled();
});
it('prevents accepting a request whose immutable metadata is missing while preserving reject', () => {
  const view = setup({
    ...workspace,
    requests: [
      { ...workspace.requests![0], lifecycle: 'proposed', endpointBindings: [] },
    ],
  });
  expect(
    view.getByText(
      'This request has no complete valid endpoint bindings. Ask the payee to publish fresh endpoints and create a new request.',
    ),
  ).toBeInTheDocument();
  expect(view.getByText('Accept request').closest('button')).toBeDisabled();
  expect(view.getByText('Reject request').closest('button')).not.toBeDisabled();
});

it('routes recurring requests to period controls without offering an unscoped payment', () => {
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
  expect(view.queryByText('A meal')).not.toBeInTheDocument();
  expect(view.getByText('Pay accepted request').closest('button')).toBeDisabled();
});
