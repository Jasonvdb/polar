import React from 'react';
import { fireEvent } from '@testing-library/react';
import { newPaykitId, PaykitReceiverWorkspace, PaykitState } from 'shared/paykitApi';
import { renderWithProviders } from 'utils/tests';
import PaykitLinks from './PaykitLinks';

const receiverId = newPaykitId();
const workspace: PaykitReceiverWorkspace = {
  receiverId,
  deliveryPaused: true,
  links: [],
  profiles: [],
  contacts: [],
  discoveries: [],
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
describe('Editable encrypted links', () => {
  it('uses the selected receiver and explicit peer path, with separate pause and queue actions', () => {
    const command = jest.fn().mockResolvedValue(undefined);
    const view = renderWithProviders(
      <PaykitLinks
        receiverId={receiverId}
        workspace={workspace}
        state={state}
        disabled={false}
        command={command}
      />,
    );
    expect(view.getByText('Sync private delivery').closest('button')).toBeDisabled();
    fireEvent.click(view.getByText('Resume private delivery'));
    expect(command).toHaveBeenCalledWith('delivery.resume', { receiverId });
    fireEvent.change(view.getByLabelText('Link peer public key'), {
      target: { value: 'y'.repeat(52) },
    });
    fireEvent.change(view.getByLabelText('Link peer receiver path'), {
      target: { value: 'bob/server' },
    });
    fireEvent.click(view.getByText('Queue empty encrypted list'));
    expect(command).toHaveBeenCalledWith('link.sendEmptyList', {
      receiverId,
      peerPublicKey: 'y'.repeat(52),
      peerReceiverPath: 'bob/server',
    });
  });
  it('shows unknown states, recovery and queued/published/received evidence independently', () => {
    const link = {
      peerPublicKey: 'peer',
      peerReceiverPath: 'bob/server',
      state: 'future-state',
      generation: 1,
      failureCount: 2,
      pendingMessages: 3,
      latestReceivedListId: '18446744073709551615',
      lastSentMessageId: '123',
      lastError: 'Peer offline',
    };
    const view = renderWithProviders(
      <PaykitLinks
        receiverId={receiverId}
        workspace={{
          ...workspace,
          links: [
            link,
            { ...link, peerReceiverPath: 'bob/wallet', state: 'recoveryRequired' },
          ],
        }}
        state={state}
        disabled
        command={jest.fn()}
      />,
    );
    expect(view.getByText(/Unsupported link state/)).toBeInTheDocument();
    expect(view.getByText(/Select this link and prepare recovery/)).toBeInTheDocument();
    expect(view.getAllByText('18446744073709551615')).toHaveLength(2);
    expect(view.getAllByText('123')).toHaveLength(2);
    expect(view.getByText('Initiate link').closest('button')).toBeDisabled();
  });
  it('routes preparation and gates only a selected recovery handshake until both markers are ready', () => {
    const command = jest.fn().mockResolvedValue(undefined);
    const recoveryLink = {
      peerPublicKey: 'y'.repeat(52),
      peerReceiverPath: 'bob/wallet',
      state: 'recoveryRequired',
      generation: 2,
      failureCount: 0,
      pendingMessages: 0,
      recoveryPreparation: {
        localMarkerPresent: true,
        remoteMarkerPresent: false,
        readyForHandshake: false,
      },
    };
    const renderLinks = (readyForHandshake: boolean) => (
      <PaykitLinks
        receiverId={receiverId}
        state={state}
        disabled={false}
        command={command}
        workspace={{
          ...workspace,
          links: [
            {
              ...recoveryLink,
              recoveryPreparation: {
                ...recoveryLink.recoveryPreparation,
                remoteMarkerPresent: readyForHandshake,
                readyForHandshake,
              },
            },
          ],
        }}
      />
    );
    const view = renderWithProviders(renderLinks(false));
    fireEvent.change(view.getByLabelText('Link peer public key'), {
      target: { value: recoveryLink.peerPublicKey },
    });
    fireEvent.change(view.getByLabelText('Link peer receiver path'), {
      target: { value: recoveryLink.peerReceiverPath },
    });
    expect(view.getByText('Initiate link').closest('button')).toBeDisabled();
    expect(view.getByText('Accept link').closest('button')).toBeDisabled();
    expect(view.getByText(/Waiting for peer recovery marker/)).toBeInTheDocument();
    fireEvent.click(view.getByText('Prepare recovery'));
    expect(command).toHaveBeenCalledWith('link.prepareRecovery', {
      receiverId,
      peerPublicKey: recoveryLink.peerPublicKey,
      peerReceiverPath: recoveryLink.peerReceiverPath,
    });
    fireEvent.click(view.getByText('Retry recovery marker'));
    expect(command).toHaveBeenCalledWith('link.retryRecoveryMarker', {
      receiverId,
      peerPublicKey: recoveryLink.peerPublicKey,
      peerReceiverPath: recoveryLink.peerReceiverPath,
    });
    view.rerender(renderLinks(true));
    fireEvent.click(view.getByText('Select link'));
    expect(view.getByText(/Both sides prepared/)).toBeInTheDocument();
    expect(view.getByText('Initiate link').closest('button')).not.toBeDisabled();
    expect(view.getByText('Accept link').closest('button')).not.toBeDisabled();
    expect(view.getByText('Retry recovery marker').closest('button')).toBeDisabled();
  });
  it('allows a selected linked peer to observe and prepare recovery', () => {
    const command = jest.fn().mockResolvedValue(undefined);
    const linkedPeer = {
      peerPublicKey: 'y'.repeat(52),
      peerReceiverPath: 'bob/wallet',
      state: 'linked',
      generation: 2,
      failureCount: 0,
      pendingMessages: 0,
    };
    const view = renderWithProviders(
      <PaykitLinks
        receiverId={receiverId}
        workspace={{ ...workspace, links: [linkedPeer] }}
        state={state}
        disabled={false}
        command={command}
      />,
    );
    fireEvent.click(view.getByText('Select link'));
    expect(view.getByText('Prepare recovery').closest('button')).not.toBeDisabled();
    fireEvent.click(view.getByText('Prepare recovery'));
    expect(command).toHaveBeenCalledWith('link.prepareRecovery', {
      receiverId,
      peerPublicKey: linkedPeer.peerPublicKey,
      peerReceiverPath: linkedPeer.peerReceiverPath,
    });
    expect(view.getByText('Initiate link').closest('button')).not.toBeDisabled();
    expect(view.getByText('Accept link').closest('button')).not.toBeDisabled();
  });
  it.each(['linking', 'blocked', 'future-state'])(
    'does not prepare a peer in the %s state',
    linkState => {
      const command = jest.fn().mockResolvedValue(undefined);
      const view = renderWithProviders(
        <PaykitLinks
          receiverId={receiverId}
          workspace={{
            ...workspace,
            links: [
              {
                peerPublicKey: 'y'.repeat(52),
                peerReceiverPath: 'bob/wallet',
                state: linkState,
                generation: 2,
                failureCount: 0,
                pendingMessages: 0,
              },
            ],
          }}
          state={state}
          disabled={false}
          command={command}
        />,
      );
      fireEvent.click(view.getByText('Select link'));
      expect(view.getByText('Prepare recovery').closest('button')).toBeDisabled();
      expect(view.getByText('Retry recovery marker').closest('button')).toBeDisabled();
    },
  );
  it('keeps preparation disabled while receiver operations are unavailable', () => {
    const view = renderWithProviders(
      <PaykitLinks
        receiverId={receiverId}
        workspace={{
          ...workspace,
          links: [
            {
              peerPublicKey: 'y'.repeat(52),
              peerReceiverPath: 'bob/wallet',
              state: 'linked',
              generation: 2,
              failureCount: 0,
              pendingMessages: 0,
            },
          ],
        }}
        state={state}
        disabled
        command={jest.fn()}
      />,
    );
    fireEvent.click(view.getByText('Select link'));
    expect(view.getByText('Prepare recovery').closest('button')).toBeDisabled();
  });
  it('does not gate a normal new link', () => {
    const view = renderWithProviders(
      <PaykitLinks
        receiverId={receiverId}
        workspace={workspace}
        state={state}
        disabled={false}
        command={jest.fn()}
      />,
    );
    fireEvent.change(view.getByLabelText('Link peer public key'), {
      target: { value: 'y'.repeat(52) },
    });
    fireEvent.change(view.getByLabelText('Link peer receiver path'), {
      target: { value: 'bob/wallet' },
    });
    expect(view.getByText('Initiate link').closest('button')).not.toBeDisabled();
    expect(view.getByText('Accept link').closest('button')).not.toBeDisabled();
  });
});
