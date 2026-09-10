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
