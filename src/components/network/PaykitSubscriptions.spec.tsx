import React from 'react';
import { fireEvent } from '@testing-library/react';
import { newPaykitId, PaykitReceiverWorkspace, PaykitState } from 'shared/paykitApi';
import { renderWithProviders } from 'utils/tests';
import PaykitSubscriptions from './PaykitSubscriptions';

const receiverId = newPaykitId();
const requestId = newPaykitId();
const workspace: PaykitReceiverWorkspace = {
  receiverId,
  deliveryPaused: false,
  links: [],
  profiles: [],
  contacts: [],
  discoveries: [],
  applicationClock: { mode: 'controlled', now: '2099-03-01T00:00:00Z' },
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
      role: 'payer',
      peerPublicKey: 'y'.repeat(52),
      peerReceiverPath: 'bob/wallet',
      lifecycle: 'activeRecurring',
      amountSats: '1000',
      description: 'Monthly work',
      paymentReference: 'reference',
      endpointBindings: [],
      proposalExpiresAt: null,
      acceptedMethods: ['btc-onchain'],
      deliveryStatus: 'sent',
      createdAt: '2099-01-31T00:00:00Z',
      recurrence: {
        every: 1,
        unit: 'month',
        startsAt: '2099-01-31T00:00:00Z',
        anchor: '2099-01-31T00:00:00Z',
        endsAt: null,
      },
    },
  ],
  subscriptions: [
    {
      requestId,
      currentPeriodIndex: 1,
      autopay: {
        enabled: false,
        walletId: null,
        source: null,
        method: null,
        status: 'disabled',
        lastError: null,
      },
      periods: [
        {
          index: 0,
          startsAt: '2099-01-31T00:00:00Z',
          endsAt: '2099-02-28T00:00:00Z',
          status: 'missed',
          offerId: newPaykitId(),
          endpointBindings: [
            {
              source: 'private',
              method: 'btc-onchain',
              endpoint: 'bcrt1period',
              reservationId: newPaykitId(),
            },
          ],
          executionId: null,
          proofId: null,
          lastError: null,
        },
      ],
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
const setup = (current = workspace, disabled = false) => {
  const command = jest.fn();
  const view = renderWithProviders(
    <PaykitSubscriptions
      receiverId={receiverId}
      workspace={current}
      state={state}
      command={command}
      disabled={disabled}
    />,
  );
  const select = (name: string, text: string) => {
    fireEvent.mouseDown(view.getByRole('combobox', { name }));
    fireEvent.click(view.getAllByText(text).slice(-1)[0]);
  };
  const chooseRequest = () =>
    select(
      'Subscription request',
      `Monthly work · ${current.requests![0].role} · ${requestId}`,
    );
  return { ...view, command, select, chooseRequest };
};

it('composes exact recurring terms without requiring reusable endpoints or enabling autopay', () => {
  const view = setup();
  for (const [label, value] of [
    ['Subscription payer public key', 'y'.repeat(52)],
    ['Subscription payer receiver path', 'alice/wallet'],
    ['Subscription amount sats', '2100000000000000'],
    ['Subscription description', 'Editable subscription'],
    ['Subscription UTC anchor', '2099-01-31T00:00:00Z'],
  ])
    fireEvent.change(view.getByLabelText(label), { target: { value } });
  view.select('Subscription accepted methods', 'btc-onchain');
  fireEvent.click(view.getByText('Create recurring request'));
  expect(view.command).toHaveBeenCalledTimes(1);
  expect(view.command).toHaveBeenCalledWith(
    'request.create',
    expect.objectContaining({
      receiverId,
      amountSats: '2100000000000000',
      recurrence: {
        every: 1,
        unit: 'month',
        startsAt: '2099-01-31T00:00:00Z',
        anchor: '2099-01-31T00:00:00Z',
        endsAt: null,
      },
    }),
  );
});
it('requires explicit source and wallet/method, manually pays a missed period and opts in separately', () => {
  const view = setup();
  view.chooseRequest();
  const pay = view.getByText('Pay selected period manually').closest('button')!;
  const authorize = view.getByText('Enable autopay for this request').closest('button')!;
  expect(pay).toBeDisabled();
  expect(authorize).toBeDisabled();
  expect(view.command).not.toHaveBeenCalled();
  view.select('Subscription spending wallet', 'Alice wallet');
  view.select('Subscription payment method', 'btc-onchain');
  expect(authorize).toBeDisabled();
  view.select('Subscription endpoint source', 'Public');
  expect(pay).toBeDisabled();
  view.select('Subscription endpoint source', 'Private');
  expect(pay).not.toBeDisabled();
  fireEvent.click(pay);
  expect(view.command).toHaveBeenLastCalledWith('payment.execute', {
    receiverId,
    requestId,
    periodIndex: 0,
    walletId: 'wallet',
    source: 'private',
    method: 'btc-onchain',
  });
  fireEvent.click(authorize);
  expect(view.command).toHaveBeenLastCalledWith('subscription.authorize', {
    receiverId,
    requestId,
    walletId: 'wallet',
    source: 'private',
    method: 'btc-onchain',
  });
});
it('blocks duplicate period execution, permits disabling authorization, and cancels explicitly', () => {
  const subscription = workspace.subscriptions![0];
  const view = setup({
    ...workspace,
    subscriptions: [
      {
        ...subscription,
        autopay: {
          ...subscription.autopay,
          enabled: true,
          status: 'blocked',
          lastError: 'Outcome unknown',
        },
        periods: [{ ...subscription.periods[0], executionId: newPaykitId() }],
      },
    ],
  });
  view.chooseRequest();
  expect(view.getByText('Outcome unknown')).toBeInTheDocument();
  expect(view.getByText('Pay selected period manually').closest('button')).toBeDisabled();
  fireEvent.click(view.getByText('Disable autopay for this request'));
  expect(view.command).toHaveBeenLastCalledWith('subscription.disable', {
    receiverId,
    requestId,
  });
  fireEvent.click(view.getByText('Cancel subscription'));
  expect(view.command).toHaveBeenLastCalledWith('request.cancel', {
    receiverId,
    requestId,
  });
});
it('waits visibly for a period offer and prevents future preparation', () => {
  const sub = workspace.subscriptions![0];
  const view = setup({ ...workspace, subscriptions: [{ ...sub, periods: [] }] });
  view.chooseRequest();
  expect(view.getByText(/Waiting for the payee’s period offer/)).toBeInTheDocument();
  expect(view.getByText('Pay selected period manually').closest('button')).toBeDisabled();
  view.unmount();
  const payee = setup({
    ...workspace,
    requests: [{ ...workspace.requests![0], role: 'payee' }],
    subscriptions: [{ ...sub, periods: [] }],
  });
  payee.chooseRequest();
  payee.select('Subscription endpoint source', 'Private');
  fireEvent.change(payee.getByLabelText('Subscription period index'), {
    target: { value: '2' },
  });
  expect(payee.getByText('Prepare period endpoints').closest('button')).toBeDisabled();
  fireEvent.change(payee.getByLabelText('Subscription period index'), {
    target: { value: '0' },
  });
  fireEvent.click(payee.getByText('Prepare period endpoints'));
  expect(payee.command).toHaveBeenCalledWith('subscription.prepare', {
    receiverId,
    requestId,
    periodIndex: 0,
    source: 'private',
    expirySeconds: 3600,
  });
});
it('allows only forward receiver clock changes and visibly blocks unsafe reset', () => {
  const view = setup();
  expect(
    view.getByText('Return receiver to system time').closest('button'),
  ).toBeDisabled();
  const set = view.getByText('Set receiver application time').closest('button')!;
  fireEvent.change(view.getByLabelText('Receiver application UTC time'), {
    target: { value: '2099-02-01T00:00:00Z' },
  });
  expect(set).toBeDisabled();
  fireEvent.change(view.getByLabelText('Receiver application UTC time'), {
    target: { value: '2099-04-01T00:00:00Z' },
  });
  expect(set).not.toBeDisabled();
  fireEvent.click(set);
  expect(view.command).toHaveBeenCalledWith('clock.set', {
    receiverId,
    now: '2099-04-01T00:00:00Z',
  });
});
it('disables money and automation controls while operation acceptance is pending', () => {
  const view = setup(workspace, true);
  view.chooseRequest();
  expect(view.getByText('Pay selected period manually').closest('button')).toBeDisabled();
  expect(
    view.getByText('Enable autopay for this request').closest('button'),
  ).toBeDisabled();
  expect(view.getByText('Cancel subscription').closest('button')).toBeDisabled();
});

it('allows a committed BOLT11 period without a raw invoice and requires the committed source', () => {
  const commitment = {
    source: 'private' as const,
    method: 'btc-lightning-bolt11' as const,
    reservationId: newPaykitId(),
    endpointHash: 'a'.repeat(64),
  };
  const subscription = workspace.subscriptions![0];
  const view = setup({
    ...workspace,
    requests: [{ ...workspace.requests![0], acceptedMethods: ['btc-lightning-bolt11'] }],
    paymentMethods: {
      enabledMethods: ['btc-lightning-bolt11'],
      preference: [],
      wallets: [
        {
          id: 'lightning',
          label: 'Alice Lightning',
          supportedMethods: ['btc-lightning-bolt11'],
          status: 'configured',
        },
      ],
    },
    subscriptions: [
      {
        ...subscription,
        periods: [
          {
            ...subscription.periods[0],
            endpointBindings: [],
            endpointCommitments: [commitment],
          },
        ],
      },
    ],
  });
  view.chooseRequest();
  expect(view.getByText(commitment.endpointHash)).toBeInTheDocument();
  expect(
    view.getByText(
      'The wallet endpoint will be resolved and checked against this commitment before payment.',
    ),
  ).toBeInTheDocument();
  const pay = view.getByText('Pay selected period manually').closest('button')!;
  expect(pay).toBeDisabled();
  view.select('Subscription spending wallet', 'Alice Lightning');
  view.select('Subscription payment method', 'btc-lightning-bolt11');
  view.select('Subscription endpoint source', 'Public');
  expect(pay).toBeDisabled();
  view.select('Subscription endpoint source', 'Private');
  expect(pay).not.toBeDisabled();
  fireEvent.click(pay);
  expect(view.command).toHaveBeenLastCalledWith('payment.execute', {
    receiverId,
    requestId,
    periodIndex: 0,
    source: 'private',
    walletId: 'lightning',
    method: 'btc-lightning-bolt11',
  });
});

it('does not fall back to full endpoints when the commitment field is explicitly empty', () => {
  const subscription = workspace.subscriptions![0];
  const view = setup({
    ...workspace,
    subscriptions: [
      {
        ...subscription,
        periods: [{ ...subscription.periods[0], endpointCommitments: [] }],
      },
    ],
  });
  view.chooseRequest();
  view.select('Subscription spending wallet', 'Alice wallet');
  view.select('Subscription payment method', 'btc-onchain');
  view.select('Subscription endpoint source', 'Private');
  expect(view.getByText('Pay selected period manually').closest('button')).toBeDisabled();
  expect(view.command).not.toHaveBeenCalled();
});
