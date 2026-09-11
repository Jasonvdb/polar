import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { newPaykitId } from 'shared/paykitApi';
import { paykitService } from 'lib/paykit/paykitService';
import PaykitBackupRecovery from './PaykitBackupRecovery';

jest.mock('lib/paykit/paykitService');
const service = paykitService as jest.Mocked<typeof paykitService>;
const receiver = {
  id: newPaykitId(),
  participantId: newPaykitId(),
  name: 'Wallet',
  path: 'bob/wallet',
  status: 'stopped' as const,
  generation: 1,
  noisePublicKey: 'public',
};

it('clears the passphrase and submits only public IDs when inspecting', async () => {
  const transferId = newPaykitId();
  const operationId = newPaykitId();
  service.prepareRestore.mockResolvedValue({
    transferId,
    purpose: 'restore',
    expiresAt: new Date(Date.now() + 60000).toISOString(),
  });
  service.command.mockResolvedValue({ operationId });
  service.operation.mockResolvedValue({
    id: operationId,
    command: 'backup.inspect',
    status: 'succeeded',
    result: {
      receiverId: receiver.id,
      transferId,
      restorable: true,
      identityMatches: true,
      receiverMatches: true,
      wallet: {
        imported: 1,
        retainedLive: 2,
        terminal: 3,
        uncertain: 0,
        unknownAfterExport: 0,
      },
      blockedReasons: [],
    },
  });
  const view = render(
    <PaykitBackupRecovery networkId={1} receiver={receiver} command={jest.fn()} />,
  );
  const password = view.getByLabelText('Backup passphrase');
  fireEvent.change(password, { target: { value: 'correct horse battery staple' } });
  fireEvent.click(view.getByText('Open and inspect backup'));
  await waitFor(() => expect(service.command).toHaveBeenCalled());
  expect(password).toHaveValue('');
  expect(service.command).toHaveBeenCalledWith(
    1,
    expect.objectContaining({
      command: 'backup.inspect',
      input: { receiverId: receiver.id, transferId },
    }),
  );
  expect(JSON.stringify(service.command.mock.calls)).not.toContain('correct horse');
  await waitFor(() =>
    expect(
      view.getByText('Restore inspected backup').closest('button'),
    ).not.toBeDisabled(),
  );
});

it('shows durable recovery gates and explicit relink controls', () => {
  const command = jest.fn();
  const peer = { peerPublicKey: 'y'.repeat(52), peerReceiverPath: 'alice/wallet' };
  const view = render(
    <PaykitBackupRecovery
      networkId={1}
      receiver={receiver}
      command={command}
      workspace={{
        receiverId: receiver.id,
        deliveryPaused: true,
        links: [
          {
            ...peer,
            state: 'recoveryRequired',
            generation: 2,
            failureCount: 0,
            pendingMessages: 0,
            recoveryPreparation: {
              localMarkerPresent: true,
              remoteMarkerPresent: false,
              readyForHandshake: false,
            },
          },
        ],
        profiles: [],
        contacts: [],
        discoveries: [],
        recovery: {
          phase: 'relinkRequired',
          automationPaused: true,
          sdkValidated: true,
          walletReconciled: true,
          identityFingerprint: 'a',
          receiverFingerprint: 'b',
          grantValid: true,
          markerValid: true,
          terminalExecutionCount: 2,
          uncertainExecutionCount: 0,
          unknownAfterExportCount: 0,
          peersRequiringRelink: [peer],
          unresolvedExecutionIds: [],
          blockedReasons: ['peer_relink_required'],
        },
      }}
    />,
  );
  expect(view.getByText(/Automation is paused/)).toBeInTheDocument();
  expect(view.getByText(/return here to prepare again/)).toBeInTheDocument();
  fireEvent.click(view.getByText('Prepare recovery with alice/wallet'));
  expect(command).toHaveBeenCalledWith('link.prepareRecovery', {
    receiverId: receiver.id,
    ...peer,
  });
  fireEvent.click(view.getByText('Retry recovery marker with alice/wallet'));
  expect(command).toHaveBeenCalledWith('link.retryRecoveryMarker', {
    receiverId: receiver.id,
    ...peer,
  });
});
