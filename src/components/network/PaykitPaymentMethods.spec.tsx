import React from 'react';
import { fireEvent } from '@testing-library/react';
import { newPaykitId, PaykitReceiverWorkspace, PaykitState } from 'shared/paykitApi';
import { renderWithProviders } from 'utils/tests';
import PaykitPaymentMethods from './PaykitPaymentMethods';

const receiverId = newPaykitId();
const peerPublicKey = 'y'.repeat(52);
const workspace: PaykitReceiverWorkspace = {
  receiverId,
  deliveryPaused: false,
  links: [],
  profiles: [],
  contacts: [],
  discoveries: [],
  paymentMethods: {
    walletId: 'lnd-0-core-0',
    enabledMethods: ['btc-onchain', 'btc-lightning-bolt11'],
    preference: ['btc-onchain'],
    wallets: [
      {
        id: 'lnd-0-core-0',
        label: 'Alice receiving wallet',
        supportedMethods: ['btc-onchain', 'btc-lightning-bolt11'],
        status: 'configured',
      },
    ],
  },
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
  const command = jest.fn().mockResolvedValue(undefined);
  return {
    command,
    ...renderWithProviders(
      <PaykitPaymentMethods
        receiverId={receiverId}
        workspace={current}
        state={state}
        disabled={disabled}
        command={command}
      />,
    ),
  };
};
describe('Editable payment methods and reservations', () => {
  it('submits exact satoshi strings, explicit wallet configuration and receiver-scoped reservations', () => {
    const view = setup();
    fireEvent.click(view.getByText('Save receiving configuration'));
    expect(view.command).toHaveBeenLastCalledWith('method.configure', {
      receiverId,
      walletId: 'lnd-0-core-0',
      enabledMethods: ['btc-onchain', 'btc-lightning-bolt11'],
      preference: ['btc-onchain'],
    });
    fireEvent.change(view.getByLabelText('Payment amount in satoshis'), {
      target: { value: '2100000000000000' },
    });
    fireEvent.change(view.getByLabelText('Endpoint expiry in seconds'), {
      target: { value: '604800' },
    });
    fireEvent.click(view.getByText('Publish public payment list'));
    expect(view.command).toHaveBeenLastCalledWith('paymentList.publish', {
      receiverId,
      amountSats: '2100000000000000',
      expirySeconds: 604800,
    });
    fireEvent.change(view.getByLabelText('Payment peer public key'), {
      target: { value: peerPublicKey },
    });
    fireEvent.change(view.getByLabelText('Payment peer receiver path'), {
      target: { value: 'bob/server' },
    });
    fireEvent.click(view.getByText('Create private reservation'));
    expect(view.command).toHaveBeenLastCalledWith('reservation.create', {
      receiverId,
      peerPublicKey,
      peerReceiverPath: 'bob/server',
      amountSats: '2100000000000000',
      expirySeconds: 604800,
    });
    fireEvent.click(view.getByText('Rotate private reservation'));
    expect(view.command.mock.calls[view.command.mock.calls.length - 1][0]).toBe(
      'reservation.rotate',
    );
  });
  it('requires explicit public/private source and does not choose a method without a saved preference', () => {
    const view = setup({
      ...workspace,
      paymentMethods: { ...workspace.paymentMethods!, preference: [] },
    });
    fireEvent.change(view.getByLabelText('Payment peer public key'), {
      target: { value: peerPublicKey },
    });
    fireEvent.change(view.getByLabelText('Payment peer receiver path'), {
      target: { value: 'bob/wallet' },
    });
    const resolve = view.getByText('Resolve selected payment list').closest('button');
    expect(resolve).toBeDisabled();
    fireEvent.mouseDown(view.getByRole('combobox', { name: 'Payment list source' }));
    fireEvent.click(view.getByText('Private encrypted list'));
    expect(resolve).toBeDisabled();
    fireEvent.mouseDown(view.getByRole('combobox', { name: 'Resolution method' }));
    fireEvent.click(view.getAllByText('Lightning BOLT11').slice(-1)[0]);
    expect(resolve).not.toBeDisabled();
    fireEvent.click(resolve!);
    expect(view.command).toHaveBeenLastCalledWith('paymentList.resolve', {
      receiverId,
      peerPublicKey,
      peerReceiverPath: 'bob/wallet',
      source: 'private',
      amountSats: '1000',
      method: 'btc-lightning-bolt11',
    });
  });
  it('shows lifecycle, delivery, cleanup and exact versions separately; only payable private lists can be consumed', () => {
    const resolution = {
      id: newPaykitId(),
      peerPublicKey,
      peerReceiverPath: 'bob/server',
      source: 'private' as const,
      amountSats: '1000',
      createdAt: '2026-01-01T00:00:00Z',
      version: '18446744073709551615',
      endpoint: 'lnbcrt1public',
      status: 'payable' as const,
    };
    const reservation = {
      id: newPaykitId(),
      listId: 'list',
      walletId: 'lnd-0-core-0',
      source: 'private' as const,
      peerPublicKey,
      peerReceiverPath: 'bob/server',
      method: 'btc-onchain',
      endpoint: 'bcrt1public',
      amountSats: '1000',
      createdAt: '2026-01-01T00:00:00Z',
      expiresAt: '2026-01-01T01:00:00Z',
      status: 'cancelled' as const,
      deliveryStatus: 'queued' as const,
      cleanupStatus: 'failed' as const,
      lastError: 'Wallet unavailable; cleanup pending',
    };
    const view = setup({
      ...workspace,
      reservations: [reservation],
      resolutions: [resolution, { ...resolution, id: newPaykitId(), status: 'consumed' }],
    });
    expect(view.getByText('Ineligible')).toBeInTheDocument();
    expect(view.getByText('queued')).toBeInTheDocument();
    expect(view.getByText('failed')).toBeInTheDocument();
    expect(view.getByText('Wallet unavailable; cleanup pending')).toBeInTheDocument();
    expect(view.getAllByText('18446744073709551615')).toHaveLength(2);
    const consume = view
      .getAllByText('Consume private list without payment')
      .map(item => item.closest('button'));
    expect(consume[0]).toBeDisabled();
    expect(consume[1]).not.toBeDisabled();
    fireEvent.click(consume[1]!);
    expect(view.command).toHaveBeenLastCalledWith('paymentList.consume', {
      receiverId,
      resolutionId: resolution.id,
    });
    expect(view.getByText('Cancel reservation').closest('button')).toBeDisabled();
    fireEvent.click(view.getByText('Reconcile reservation'));
    expect(view.command).toHaveBeenLastCalledWith('reservation.reconcile', {
      receiverId,
      reservationId: reservation.id,
    });
  });
  it('disables mutation controls when the receiver is stopped', () => {
    const view = setup(workspace, true);
    for (const label of [
      'Save receiving configuration',
      'Save method preference',
      'Publish public payment list',
      'Create private reservation',
      'Rotate private reservation',
    ])
      expect(view.getByText(label).closest('button')).toBeDisabled();
    expect(view.command).not.toHaveBeenCalled();
  });
});
