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
  fireEvent.change(view.getByLabelText('Receipt note'), {
    target: { value: 'First receiver receipt draft' },
  });
  fireEvent.change(view.getByLabelText('Subscription description'), {
    target: { value: 'Receiver one subscription' },
  });
  fireEvent.change(view.getByLabelText('Receiver application UTC time'), {
    target: { value: '2099-01-01T00:00:00Z' },
  });
  select('Receiver', 'Receiver 2 (running)');
  expect(view.getByLabelText('Subscription description')).toHaveValue('');
  expect(view.getByLabelText('Receiver application UTC time')).toHaveValue('');
  expect(view.getByLabelText('Receipt note')).toHaveValue('');
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

const interruptedFunding = (status: 'running' | 'uncertain'): PaykitState => ({
  ...state,
  funding: {
    status,
    funded: false,
    step: 'channels',
    wallets: [],
    channelPoints: ['original:0'],
    lastError: 'Funding was interrupted. Recover the original setup.',
  },
  operations: [
    {
      id: environment.environmentId,
      command: 'preset.fund',
      status: 'failed',
      error: {
        code: 'reconciliation_required',
        message: 'Inspect the interrupted operation.',
      },
    },
  ],
});
it.each(['uncertain', 'running'] as const)(
  'exposes recovery for interrupted %s funding and preserves uncertain submission identity',
  async status => {
    service.state.mockResolvedValue(interruptedFunding(status));
    service.command
      .mockRejectedValueOnce(new Error('Paykit service is unavailable'))
      .mockResolvedValueOnce({ operationId: newPaykitId() });
    const view = setup();
    const recover = await view.findByText('Recover funded preset');
    await waitFor(() => expect(recover.closest('button')).not.toBeDisabled());
    fireEvent.click(recover);
    const retry = await view.findByText('Retry command');
    expect(recover.closest('button')).toBeDisabled();
    expect(service.command).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ command: 'preset.fund', input: {} }),
    );
    expect(service.command.mock.calls[0][1].commandId).not.toBe(
      environment.environmentId,
    );
    fireEvent.click(retry);
    await waitFor(() => expect(service.command).toHaveBeenCalledTimes(2));
    expect(service.command.mock.calls[1]).toEqual(service.command.mock.calls[0]);
  },
);
it.each(['queued', 'running'] as const)(
  'keeps funding recovery disabled while an actual funding operation is %s',
  async status => {
    const snapshot = interruptedFunding('uncertain');
    snapshot.operations.push({ id: newPaykitId(), command: 'preset.fund', status });
    service.state.mockResolvedValue(snapshot);
    const view = setup();
    const recover = await view.findByText('Recover funded preset');
    expect(recover.closest('button')).toBeDisabled();
    fireEvent.click(recover);
    expect(service.command).not.toHaveBeenCalled();
  },
);

it('retries uncertain receipt acceptance with its original ID and terminal failures with a fresh ID', async () => {
  const participantId = newPaykitId();
  const receiverId = newPaykitId();
  const receiptId = newPaykitId();
  const operationId = newPaykitId();
  const current: PaykitState = {
    ...state,
    participants: [{ id: participantId, name: 'Bob', publicKey: 'y'.repeat(52) }],
    receivers: [
      {
        id: receiverId,
        participantId,
        name: 'Wallet',
        path: 'bob/wallet',
        status: 'running',
        generation: 1,
        noisePublicKey: 'public',
      },
    ],
    receiverWorkspaces: [
      {
        receiverId,
        deliveryPaused: false,
        links: [],
        profiles: [],
        contacts: [],
        discoveries: [],
        receiptAccess: [
          {
            receiptId,
            peerPublicKey: 'o'.repeat(52),
            peerReceiverPath: 'alice/wallet',
            accessEventId: newPaykitId(),
            requestId: null,
            paymentReference: 'ref',
            retrievalStatus: 'failed',
            receivedAt: 'today',
            attemptedAt: 'today',
            retrievedAt: null,
            lastError: 'Receipt decryption failed.',
          },
        ],
      },
    ],
  };
  service.state.mockResolvedValue(current);
  service.command
    .mockRejectedValueOnce(new Error('Paykit service is unavailable'))
    .mockResolvedValueOnce({ operationId })
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
  select('Receiver', 'Wallet (running)');
  const button = view.getByText('Retry retrieval and decryption').closest('button')!;
  fireEvent.click(button);
  fireEvent.click(await view.findByText('Retry command'));
  await waitFor(() => expect(service.command).toHaveBeenCalledTimes(2));
  expect(service.command.mock.calls[0]).toEqual(service.command.mock.calls[1]);
  await waitFor(() => expect(view.queryByText('Retry command')).not.toBeInTheDocument());
  expect(button).toBeDisabled(); // accepted operation has not appeared in the next poll yet
  service.state.mockResolvedValue({
    ...current,
    operations: [
      {
        id: operationId,
        command: 'receipt.retrieve',
        status: 'failed',
        error: { code: 'receipt', message: 'Receipt decryption failed.' },
      },
    ],
  });
  await waitFor(() => expect(button).not.toBeDisabled(), { timeout: 2500 });
  fireEvent.click(button);
  await waitFor(() => expect(service.command).toHaveBeenCalledTimes(3));
  expect(service.command.mock.calls[2][1].commandId).not.toBe(
    service.command.mock.calls[1][1].commandId,
  );
  expect(service.command.mock.calls[2][1].input).toEqual(
    service.command.mock.calls[1][1].input,
  );
});

it('retains clock command identity after uncertain acceptance and blocks actions until its operation is terminal', async () => {
  const participantId = newPaykitId();
  const receiverId = newPaykitId();
  const operationId = newPaykitId();
  const current: PaykitState = {
    ...state,
    participants: [{ id: participantId, name: 'Clock Bob', publicKey: 'y'.repeat(52) }],
    receivers: [
      {
        id: receiverId,
        participantId,
        name: 'Clock wallet',
        path: 'clock/wallet',
        status: 'running',
        generation: 1,
        noisePublicKey: 'public',
      },
    ],
    receiverWorkspaces: [
      {
        receiverId,
        deliveryPaused: false,
        links: [],
        contacts: [],
        discoveries: [],
        profiles: [],
        applicationClock: { mode: 'system', now: '2026-09-11T00:00:00Z' },
      },
    ],
  };
  service.state.mockResolvedValue(current);
  service.command
    .mockRejectedValueOnce(new Error('Paykit service is unavailable'))
    .mockResolvedValueOnce({ operationId });
  const view = setup();
  await waitFor(() =>
    expect(
      view.getByText('Create Alice / Bob / Carol preset').closest('button'),
    ).not.toBeDisabled(),
  );
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Participant' }));
  fireEvent.click(view.getByText('Clock Bob'));
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Receiver' }));
  fireEvent.click(view.getByText('Clock wallet (running)'));
  fireEvent.change(view.getByLabelText('Receiver application UTC time'), {
    target: { value: '2099-01-01T00:00:00Z' },
  });
  const button = view.getByText('Set receiver application time').closest('button')!;
  fireEvent.click(button);
  fireEvent.click(await view.findByText('Retry command'));
  await waitFor(() => expect(service.command).toHaveBeenCalledTimes(2));
  expect(service.command.mock.calls[0]).toEqual(service.command.mock.calls[1]);
  await waitFor(() => expect(view.queryByText('Retry command')).not.toBeInTheDocument());
  expect(button).toBeDisabled();
  service.state.mockResolvedValue({
    ...current,
    operations: [{ id: operationId, command: 'clock.set', status: 'succeeded' }],
  });
  await waitFor(() => expect(button).not.toBeDisabled(), { timeout: 2500 });
});

it('shows actionable oversized-proposal failure and lets the user shorten terms with a new command', async () => {
  const participantId = newPaykitId();
  const receiverId = newPaykitId();
  const operationId = newPaykitId();
  const current: PaykitState = {
    ...state,
    participants: [
      { id: participantId, name: 'Proposal Bob', publicKey: 'y'.repeat(52) },
    ],
    receivers: [
      {
        id: receiverId,
        participantId,
        name: 'Proposal wallet',
        path: 'proposal/wallet',
        status: 'running',
        generation: 1,
        noisePublicKey: 'public',
      },
    ],
    receiverWorkspaces: [
      {
        receiverId,
        deliveryPaused: false,
        links: [],
        contacts: [],
        discoveries: [],
        profiles: [],
      },
    ],
  };
  service.state.mockResolvedValue(current);
  service.command
    .mockResolvedValueOnce({ operationId })
    .mockResolvedValueOnce({ operationId: newPaykitId() });
  const view = setup();
  await waitFor(() =>
    expect(
      view.getByText('Create Alice / Bob / Carol preset').closest('button'),
    ).not.toBeDisabled(),
  );
  const select = (name: string, text: string) => {
    fireEvent.mouseDown(view.getByRole('combobox', { name }));
    fireEvent.click(view.getAllByText(text).slice(-1)[0]);
  };
  select('Participant', 'Proposal Bob');
  select('Receiver', 'Proposal wallet (running)');
  for (const [label, value] of [
    ['Subscription payer public key', 'y'.repeat(52)],
    ['Subscription payer receiver path', 'alice/wallet'],
    ['Subscription description', 'x'.repeat(500)],
    ['Subscription UTC anchor', '2099-01-31T00:00:00Z'],
  ])
    fireEvent.change(view.getByLabelText(label), { target: { value } });
  select('Subscription accepted methods', 'btc-onchain');
  const create = view.getByText('Create recurring request').closest('button')!;
  fireEvent.click(create);
  await waitFor(() => expect(service.command).toHaveBeenCalledTimes(1));
  expect(create).toBeDisabled();
  const message =
    'The encrypted request exceeds its message limit. Shorten the description or select fewer payment methods, then create a new request.';
  service.state.mockResolvedValue({
    ...current,
    operations: [
      {
        id: operationId,
        command: 'request.create',
        status: 'failed',
        error: { code: 'receiver_operation_failed', message },
      },
    ],
  });
  await view.findByText(`receiver_operation_failed: ${message}`, {}, { timeout: 2500 });
  expect(view.queryByText('Retry command')).not.toBeInTheDocument();
  expect(view.getByLabelText('Subscription description')).toHaveValue('x'.repeat(500));
  expect(create).not.toBeDisabled();
  fireEvent.change(view.getByLabelText('Subscription description'), {
    target: { value: 'Monthly service' },
  });
  fireEvent.click(create);
  await waitFor(() => expect(service.command).toHaveBeenCalledTimes(2));
  const first = service.command.mock.calls[0][1];
  const second = service.command.mock.calls[1][1];
  expect(first.command).toBe('request.create');
  expect(second.commandId).not.toBe(first.commandId);
  expect(second.input).toEqual({ ...first.input, description: 'Monthly service' });
});
