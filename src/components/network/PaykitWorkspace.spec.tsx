import React from 'react';
import { fireEvent, waitFor } from '@testing-library/react';
import { newPaykitId, PaykitState } from 'shared/paykitApi';
import { Status } from 'shared/types';
import { paykitService } from 'lib/paykit/paykitService';
import { getNetwork, renderWithProviders } from 'utils/tests';
import PaykitWorkspace from './PaykitWorkspace';

jest.mock('lib/paykit/paykitService');
const service = paykitService as jest.Mocked<typeof paykitService>;
const environment = {
  apiVersion: 1 as const,
  environmentId: newPaykitId(),
  servicePort: 30091,
};
const state: PaykitState = {
  ...environment,
  ready: true,
  participants: [],
  receivers: [],
  operations: [],
  lastEventSequence: 0,
};
const setup = (enabled = true, status = Status.Started) => {
  const network = {
    ...getNetwork(1, 'test', status),
    ...(enabled ? { paykit: environment } : {}),
  };
  return renderWithProviders(<PaykitWorkspace network={network} />, {
    initialState: { network: { networks: [network] } },
  });
};
describe('Paykit workspace', () => {
  beforeEach(() => service.state.mockResolvedValue(state));
  it('enables only stopped networks and never calls the API before startup', async () => {
    const view = setup(false);
    expect(view.getByText('Enable Paykit').closest('button')).toBeDisabled();
    expect(service.state).not.toHaveBeenCalled();
  });
  it('keeps the command ID across uncertain acceptance and prevents another command', async () => {
    service.command
      .mockRejectedValueOnce(new Error('Paykit service is unavailable'))
      .mockResolvedValueOnce({ operationId: newPaykitId() });
    const view = setup();
    const button = view.getByText('Create Alice / Bob / Carol preset');
    await waitFor(() => expect(button.closest('button')).not.toBeDisabled());
    fireEvent.click(button);
    const retry = await view.findByText('Retry command');
    expect(button.closest('button')).toBeDisabled();
    fireEvent.click(retry);
    await waitFor(() => expect(service.command).toHaveBeenCalledTimes(2));
    expect(service.command.mock.calls[0]).toEqual(service.command.mock.calls[1]);
    await waitFor(() =>
      expect(view.queryByText('Retry command')).not.toBeInTheDocument(),
    );
  });
  it('submits editable participant names and displays durable operation failures', async () => {
    service.command.mockResolvedValue({ operationId: newPaykitId() });
    service.state.mockResolvedValue({
      ...state,
      operations: [
        {
          id: newPaykitId(),
          command: 'receiver.start',
          status: 'failed',
          error: { code: 'storage', message: 'Receiver storage unavailable' },
        },
      ],
    });
    const view = setup();
    await view.findByText('storage: Receiver storage unavailable');
    fireEvent.change(view.getByLabelText('Participant name'), {
      target: { value: 'Dora' },
    });
    fireEvent.click(view.getByText('Create participant'));
    await waitFor(() =>
      expect(service.command).toHaveBeenCalledWith(
        1,
        expect.objectContaining({
          command: 'participant.create',
          input: { name: 'Dora' },
        }),
      ),
    );
  });
});

it('resets receiver drafts on selection and preserves uncertain peer-command identity across edits', async () => {
  const participantId = newPaykitId();
  const firstId = newPaykitId();
  const secondId = newPaykitId();
  service.state.mockResolvedValue({
    ...state,
    participants: [{ id: participantId, name: 'Bob', publicKey: 'y'.repeat(52) }],
    receivers: [firstId, secondId].map((id, index) => ({
      id,
      participantId,
      name: `Receiver ${index + 1}`,
      path: `bob${index}/wallet`,
      status: 'running' as const,
      generation: 1,
      noisePublicKey: 'public',
    })),
    receiverWorkspaces: [firstId, secondId].map(receiverId => ({
      receiverId,
      deliveryPaused: false,
      links: [],
      profiles: [],
      contacts: [],
      discoveries: [],
    })),
  });
  service.command
    .mockRejectedValueOnce(new Error('Paykit service is unavailable'))
    .mockResolvedValueOnce({ operationId: newPaykitId() });
  const view = setup();
  await waitFor(() =>
    expect(
      view.getByText('Create Alice / Bob / Carol preset').closest('button'),
    ).not.toBeDisabled(),
  );
  const select = (label: string, text: string) => {
    fireEvent.mouseDown(
      view.getAllByLabelText(label).find(element => element.tagName === 'INPUT')!,
    );
    fireEvent.click(view.getByText(text));
  };
  select('Participant', 'Bob');
  select('Receiver', 'Receiver 1 (running)');
  fireEvent.change(view.getByLabelText('Link peer public key'), {
    target: { value: 'y'.repeat(52) },
  });
  fireEvent.change(view.getByLabelText('Profile display name'), {
    target: { value: 'Draft for first receiver' },
  });
  fireEvent.change(view.getByLabelText('Contact label'), {
    target: { value: 'Private first draft' },
  });
  select('Receiver', 'Receiver 2 (running)');
  expect(view.getByLabelText('Link peer public key')).toHaveValue('');
  expect(view.getByLabelText('Profile display name')).toHaveValue('');
  expect(view.getByLabelText('Contact label')).toHaveValue('');
  fireEvent.change(view.getByLabelText('Link peer public key'), {
    target: { value: 'y'.repeat(52) },
  });
  fireEvent.change(view.getByLabelText('Link peer receiver path'), {
    target: { value: 'alice/wallet' },
  });
  fireEvent.click(view.getByText('Initiate link'));
  await view.findByText('Retry command');
  expect(view.getByText('Pause private delivery').closest('button')).toBeDisabled();
  expect(view.getByText('Initiate link').closest('button')).toBeDisabled();
  fireEvent.change(view.getByLabelText('Link peer receiver path'), {
    target: { value: 'carol/server' },
  });
  fireEvent.click(view.getByText('Retry command'));
  await waitFor(() => expect(service.command).toHaveBeenCalledTimes(2));
  expect(service.command.mock.calls[0]).toEqual(service.command.mock.calls[1]);
  expect(service.command.mock.calls[1][1].input).toEqual({
    receiverId: secondId,
    peerPublicKey: 'y'.repeat(52),
    peerReceiverPath: 'alice/wallet',
  });
});

it('starts the funded preset through the same asynchronous backend command', async () => {
  service.state.mockResolvedValue(state);
  service.command.mockResolvedValue({ operationId: newPaykitId() });
  const view = setup();
  const button = view
    .getByText('Create funded Alice / Bob / Carol preset')
    .closest('button')!;
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  await waitFor(() =>
    expect(service.command).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ command: 'preset.fund', input: {} }),
    ),
  );
});

it('keeps controls usable when credential preflight proves a command was never submitted', async () => {
  service.state.mockResolvedValue(state);
  service.command.mockRejectedValueOnce(
    new Error('Paykit command not submitted: Local wallet authorization is unavailable.'),
  );
  const view = setup();
  const button = view
    .getByText('Create funded Alice / Bob / Carol preset')
    .closest('button')!;
  await waitFor(() => expect(button).not.toBeDisabled());
  fireEvent.click(button);
  await view.findByText(
    'Paykit command not submitted: Local wallet authorization is unavailable.',
  );
  expect(view.queryByText('Retry command')).not.toBeInTheDocument();
  expect(button).not.toBeDisabled();
});
