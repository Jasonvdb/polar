import React from 'react';
import { fireEvent, render } from '@testing-library/react';
import PaykitGuidedScenarios from './PaykitGuidedScenarios';
import { PaykitGuideCatalog, PaykitDiagnostics } from 'shared/paykitGuides';
import { PaykitParticipant, PaykitReceiver } from 'shared/paykitApi';

const participants: PaykitParticipant[] = [
  { id: 'alice', name: 'Alice', publicKey: 'alice-public-key' },
  { id: 'bob', name: 'Bob', publicKey: 'bob-public-key' },
];
const receivers: PaykitReceiver[] = [
  {
    id: 'alice-wallet',
    participantId: 'alice',
    name: 'Wallet',
    path: 'alice/wallet',
    status: 'running',
    generation: 1,
    noisePublicKey: 'alice-noise',
  },
  {
    id: 'bob-wallet',
    participantId: 'bob',
    name: 'Wallet',
    path: 'bob/wallet',
    status: 'running',
    generation: 1,
    noisePublicKey: 'bob-noise',
  },
];
const catalog: PaykitGuideCatalog = {
  apiVersion: 1,
  catalogVersion: 1,
  panels: [
    { id: 'workspace', title: 'Workspace' },
    { id: 'links', title: 'Links' },
  ],
  commands: [],
  scenarios: [
    {
      id: 'funded-workspace',
      title: 'Funded workspace',
      prerequisites: ['The Paykit service is ready.'],
      steps: [
        {
          id: 'create-preset',
          panelId: 'workspace',
          command: 'preset.create',
          requiredParameters: [],
          checkpoint: 'Alice, Bob, and Carol are visible.',
          recoveryHint: 'Inspect the original operation before retrying.',
          transport: 'command',
        },
      ],
    },
    {
      id: 'multi-receiver-links',
      title: 'Multi-receiver links',
      prerequisites: ['Both receivers are running.'],
      steps: [
        {
          id: 'initiate',
          panelId: 'links',
          command: 'link.initiate',
          requiredParameters: ['receiverId', 'peerPublicKey', 'peerReceiverPath'],
          checkpoint: 'The invitation is waiting for an explicit peer decision.',
          recoveryHint: 'Retry with the same peer identity and path.',
          transport: 'command',
        },
      ],
    },
  ],
};
const diagnostics: PaykitDiagnostics = {
  apiVersion: 1,
  environmentId: 'environment',
  ready: true,
  fundingStatus: 'ready',
  receivers: [],
  operations: [],
  lastEventSequence: 1,
};

const setup = (
  overrides: Partial<React.ComponentProps<typeof PaykitGuidedScenarios>> = {},
) => {
  const callbacks = {
    onNavigate: jest.fn(),
    onSelectReceiver: jest.fn(),
    onSelectPeer: jest.fn(),
    onOpenPanel: jest.fn(),
    onAcknowledgeStep: jest.fn(),
  };
  return {
    ...callbacks,
    ...render(
      <PaykitGuidedScenarios
        catalog={catalog}
        diagnostics={diagnostics}
        participants={participants}
        receivers={receivers}
        {...callbacks}
        {...overrides}
      />,
    ),
  };
};

it('opens existing controls and keeps checkpoint acknowledgement separate', () => {
  const view = setup();
  fireEvent.click(view.getByText('Open Workspace controls'));
  expect(view.onOpenPanel).toHaveBeenCalledWith('workspace');
  expect(view.getByText('Alice, Bob, and Carol are visible.')).toBeInTheDocument();
  fireEvent.click(view.getByText('I observed this checkpoint'));
  expect(view.onAcknowledgeStep).toHaveBeenCalledWith(
    'funded-workspace',
    'create-preset',
  );
});

it('requires and forwards explicit actor and peer focus', () => {
  const view = setup({
    viewState: {
      environmentId: 'environment',
      networkId: 9,
      scenarioId: 'multi-receiver-links',
      stepId: 'initiate',
    },
  });
  const open = view.getByText('Open Links controls').closest('button')!;
  expect(open).toBeDisabled();
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Guide actor receiver' }));
  fireEvent.click(view.getByText('Alice / Wallet (alice/wallet)'));
  expect(view.onSelectReceiver).toHaveBeenCalledWith('alice-wallet');

  view.rerender(
    <PaykitGuidedScenarios
      catalog={catalog}
      diagnostics={diagnostics}
      participants={participants}
      receivers={receivers}
      viewState={{
        environmentId: 'environment',
        networkId: 9,
        scenarioId: 'multi-receiver-links',
        stepId: 'initiate',
      }}
      selectedReceiverId="alice-wallet"
      onNavigate={view.onNavigate}
      onSelectReceiver={view.onSelectReceiver}
      onSelectPeer={view.onSelectPeer}
      onOpenPanel={view.onOpenPanel}
      onAcknowledgeStep={view.onAcknowledgeStep}
    />,
  );
  fireEvent.mouseDown(view.getByRole('combobox', { name: 'Guide peer receiver' }));
  fireEvent.click(view.getAllByText('Bob / Wallet (bob/wallet)').slice(-1)[0]);
  expect(view.onSelectPeer).toHaveBeenCalledWith({
    receiverId: 'bob-wallet',
    publicKey: 'bob-public-key',
    receiverPath: 'bob/wallet',
  });
});

it('shows a failed operation and recovery without claiming the checkpoint passed', () => {
  const view = setup({
    pendingOperationId: 'operation-1',
    diagnostics: {
      ...diagnostics,
      operations: [
        {
          id: 'operation-1',
          command: 'preset.create',
          status: 'failed',
          errorCode: 'reconciliation_required',
        },
      ],
    },
  });
  expect(view.getByText('Current operation: failed')).toBeInTheDocument();
  expect(view.getByText(/reconciliation_required/)).toBeInTheDocument();
  expect(view.getByText('I observed this checkpoint')).toBeEnabled();
  expect(view.queryByText('Checkpoint acknowledged')).not.toBeInTheDocument();
});

it('labels only an explicitly acknowledged step as complete', () => {
  const view = setup({ acknowledgedStepIds: ['funded-workspace:create-preset'] });
  expect(view.getByText('Checkpoint acknowledged').closest('button')).toBeDisabled();
});
