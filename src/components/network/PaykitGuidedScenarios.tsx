import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Select,
  Space,
  Steps,
  Tag,
  Typography,
} from 'antd';
import { PaykitParticipant, PaykitReceiver } from 'shared/paykitApi';
import {
  PaykitDiagnostics,
  PaykitGuideCatalog,
  PaykitGuidePeerFocus,
  PaykitGuideViewState,
} from 'shared/paykitGuides';

export interface PaykitGuidedScenariosProps {
  catalog: PaykitGuideCatalog;
  diagnostics?: PaykitDiagnostics;
  participants: PaykitParticipant[];
  receivers: PaykitReceiver[];
  viewState?: PaykitGuideViewState;
  selectedReceiverId?: string;
  selectedPeer?: PaykitGuidePeerFocus;
  acknowledgedStepIds?: string[];
  pendingOperationId?: string;
  pendingOperationContext?: {
    scenarioId: string;
    stepId: string;
    receiverId?: string;
  };
  onNavigate: (scenarioId: string, stepId: string) => void;
  onSelectReceiver: (receiverId: string) => void;
  onSelectPeer: (peer: PaykitGuidePeerFocus) => void;
  onOpenPanel: (panelId: string) => void;
  onAcknowledgeStep: (scenarioId: string, stepId: string) => void;
}

const peerParameters = ['peerPublicKey', 'peerReceiverPath'];

const PaykitGuidedScenarios: React.FC<PaykitGuidedScenariosProps> = props => {
  const {
    catalog,
    diagnostics,
    participants,
    receivers,
    viewState,
    selectedReceiverId,
    selectedPeer,
    acknowledgedStepIds = [],
    pendingOperationId,
    pendingOperationContext,
    onNavigate,
    onSelectReceiver,
    onSelectPeer,
    onOpenPanel,
    onAcknowledgeStep,
  } = props;
  const initialScenario =
    catalog.scenarios.find(item => item.id === viewState?.scenarioId) ||
    catalog.scenarios[0];
  const [scenarioId, setScenarioId] = useState(initialScenario?.id);
  const scenario =
    catalog.scenarios.find(item => item.id === scenarioId) || catalog.scenarios[0];
  const initialStep = Math.max(
    0,
    scenario?.steps.findIndex(item => item.id === viewState?.stepId) ?? 0,
  );
  const [stepIndex, setStepIndex] = useState(initialStep);
  const step = scenario?.steps[stepIndex] || scenario?.steps[0];

  useEffect(() => {
    if (!viewState) return;
    const nextScenario = catalog.scenarios.find(item => item.id === viewState.scenarioId);
    const nextStep =
      nextScenario?.steps.findIndex(item => item.id === viewState.stepId) ?? -1;
    if (nextScenario && nextStep >= 0) {
      setScenarioId(nextScenario.id);
      setStepIndex(nextStep);
    }
  }, [catalog, viewState]);

  const selectStep = (index: number) => {
    if (!scenario) return;
    setStepIndex(index);
    onNavigate(scenario.id, scenario.steps[index].id);
  };
  const operation = useMemo(() => {
    const explicitlyBound =
      pendingOperationContext?.scenarioId === scenario.id &&
      pendingOperationContext.stepId === step.id &&
      pendingOperationContext.receiverId === selectedReceiverId;
    if (!pendingOperationId || !explicitlyBound) return undefined;
    return diagnostics?.operations.find(
      item => item.id === pendingOperationId && item.command === step.command,
    );
  }, [
    diagnostics,
    pendingOperationContext,
    pendingOperationId,
    scenario,
    selectedReceiverId,
    step,
  ]);
  const needsReceiver = step?.requiredParameters.includes('receiverId');
  const needsPeer = step?.requiredParameters.some(parameter =>
    peerParameters.includes(parameter),
  );
  const actor = receivers.find(item => item.id === selectedReceiverId);
  const peers = receivers.filter(item => item.participantId !== actor?.participantId);
  const choicesReady = (!needsReceiver || !!actor) && (!needsPeer || !!selectedPeer);
  const acknowledgedKey = `${scenario.id}:${step.id}`;
  const acknowledged = acknowledgedStepIds.includes(acknowledgedKey);
  const panel = catalog.panels.find(item => item.id === step?.panelId);

  if (!scenario || !step) {
    return <Alert type="warning" message="The Paykit guide catalog has no scenarios." />;
  }

  return (
    <Card title="Guided Paykit scenarios" style={{ marginTop: 12 }}>
      <Typography.Paragraph>
        Follow the published workflow while retaining control of every peer decision and
        payment. Guides open the existing manual controls; they do not execute actions.
      </Typography.Paragraph>
      <Select
        aria-label="Guided scenario"
        value={scenario.id}
        style={{ minWidth: 320, marginBottom: 16 }}
        onChange={(id: string) => {
          const next = catalog.scenarios.find(item => item.id === id)!;
          setScenarioId(id);
          setStepIndex(0);
          onNavigate(id, next.steps[0].id);
        }}
      >
        {catalog.scenarios.map(item => (
          <Select.Option key={item.id} value={item.id}>
            {item.title}
          </Select.Option>
        ))}
      </Select>
      <Alert
        type={diagnostics?.ready ? 'success' : 'warning'}
        showIcon
        message={
          diagnostics?.ready ? 'Paykit service ready' : 'Paykit service is not ready'
        }
        description={`Funding: ${diagnostics?.fundingStatus || 'unavailable'}`}
      />
      <Typography.Title level={5}>Requirements</Typography.Title>
      <ul>
        {scenario.prerequisites.map(item => (
          <li key={item}>{item}</li>
        ))}
      </ul>
      <Steps
        current={stepIndex}
        onChange={selectStep}
        items={scenario.steps.map(item => ({
          title: item.command,
          status: acknowledgedStepIds.includes(`${scenario.id}:${item.id}`)
            ? 'finish'
            : 'wait',
        }))}
        size="small"
      />
      <Space direction="vertical" style={{ width: '100%', marginTop: 16 }}>
        {needsReceiver && (
          <Select
            aria-label="Guide actor receiver"
            placeholder="Choose the receiver that acts"
            value={selectedReceiverId}
            style={{ minWidth: 320 }}
            onChange={(id: string) => onSelectReceiver(id)}
          >
            {receivers.map(receiver => (
              <Select.Option key={receiver.id} value={receiver.id}>
                {participants.find(item => item.id === receiver.participantId)?.name} /{' '}
                {receiver.name} ({receiver.path})
              </Select.Option>
            ))}
          </Select>
        )}
        {needsPeer && (
          <Select
            aria-label="Guide peer receiver"
            placeholder="Choose the peer receiver"
            value={selectedPeer?.receiverId}
            style={{ minWidth: 320 }}
            disabled={!actor}
            onChange={(id: string) => {
              const receiver = receivers.find(item => item.id === id)!;
              const owner = participants.find(
                item => item.id === receiver.participantId,
              )!;
              onSelectPeer({
                receiverId: receiver.id,
                publicKey: owner.publicKey,
                receiverPath: receiver.path,
              });
            }}
          >
            {peers.map(receiver => (
              <Select.Option key={receiver.id} value={receiver.id}>
                {participants.find(item => item.id === receiver.participantId)?.name} /{' '}
                {receiver.name} ({receiver.path})
              </Select.Option>
            ))}
          </Select>
        )}
        {needsPeer && selectedPeer && (
          <Typography.Text type="secondary">
            Peer: {selectedPeer.publicKey} / {selectedPeer.receiverPath}
          </Typography.Text>
        )}
        <Descriptions bordered size="small" column={1}>
          <Descriptions.Item label="Action">{step.command}</Descriptions.Item>
          <Descriptions.Item label="Required input">
            {step.requiredParameters.join(', ') || 'No form input'}
          </Descriptions.Item>
          <Descriptions.Item label="Checkpoint">{step.checkpoint}</Descriptions.Item>
          <Descriptions.Item label="Recovery">{step.recoveryHint}</Descriptions.Item>
          <Descriptions.Item label="Transport">
            {step.transport === 'fileDescriptorBackup'
              ? 'Native backup file dialog'
              : 'Existing manual command form'}
          </Descriptions.Item>
        </Descriptions>
        {operation && (
          <Alert
            type={operation.status === 'failed' ? 'error' : 'info'}
            showIcon
            message={`Current operation: ${operation.status}`}
            description={
              operation.status === 'failed'
                ? `Error: ${operation.errorCode || 'unavailable'}. ${step.recoveryHint}`
                : `Operation ${operation.id}. Confirm the checkpoint separately when it is observable.`
            }
          />
        )}
        <Space wrap>
          <Button
            type="primary"
            disabled={!choicesReady}
            onClick={() => onOpenPanel(step.panelId)}
          >
            Open {panel?.title || step.panelId} controls
          </Button>
          <Button
            disabled={!choicesReady || acknowledged}
            onClick={() => onAcknowledgeStep(scenario.id, step.id)}
          >
            {acknowledged ? 'Checkpoint acknowledged' : 'I observed this checkpoint'}
          </Button>
          {operation && <Tag>{operation.command}</Tag>}
        </Space>
      </Space>
    </Card>
  );
};

export default PaykitGuidedScenarios;
