import React, { useEffect, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Input,
  List,
  Select,
  Space,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import {
  newPaykitId,
  validatePaykitCommand,
  PaykitCommand,
  PaykitCommandRequest,
  PaykitState,
  PaykitInput,
} from 'shared/paykitApi';
import {
  PaykitDiagnostics,
  PaykitGuideCatalog,
  PaykitGuidePeerFocus,
  PaykitGuideViewState,
} from 'shared/paykitGuides';
import { Status } from 'shared/types';
import { useStoreActions } from 'store';
import { Network } from 'types';
import { paykitService } from 'lib/paykit/paykitService';
import PaykitRequests from './PaykitRequests';
import PaykitSubscriptions from './PaykitSubscriptions';
import PaykitProofs from './PaykitProofs';
import PaykitReceipts from './PaykitReceipts';
import PaykitPaymentMethods from './PaykitPaymentMethods';
import PaykitLinks from './PaykitLinks';
import PaykitProfilesContacts from './PaykitProfilesContacts';
import PaykitBackupRecovery from './PaykitBackupRecovery';
import PaykitImageSetup from './PaykitImageSetup';
import PaykitGuidedScenarios from './PaykitGuidedScenarios';

const workbenchPages = [
  ['workspace', 'Workspace'],
  ['guides', 'Guides'],
  ['requests', 'Requests'],
  ['subscriptions', 'Subscriptions'],
  ['links', 'Links'],
  ['methods', 'Methods / Reservations'],
  ['proofs', 'Proofs / Receipts'],
  ['profiles', 'Profiles / Contacts'],
  ['backup', 'Backup / Recovery'],
] as const;

const guardedCommand = (name: string) =>
  name.startsWith('subscription.') ||
  name.startsWith('clock.') ||
  ['payment.execute', 'request.create', 'request.accept', 'request.cancel'].includes(
    name,
  );

const PaykitWorkspace: React.FC<{ network: Network }> = ({ network }) => {
  const { enablePaykit, stop } = useStoreActions(s => s.network);
  const [state, setState] = useState<PaykitState>();
  const [error, setError] = useState('');
  const [connectionError, setConnectionError] = useState('');
  const [busy, setBusy] = useState(false);
  const [participantId, selectParticipant] = useState<string>();
  const [receiverId, selectReceiver] = useState<string>();
  const [participantName, setParticipantName] = useState('');
  const [receiverName, setReceiverName] = useState('');
  const [kind, setKind] = useState<'wallet' | 'server'>('wallet');
  const [retry, setRetry] = useState<PaykitCommandRequest>();
  const [operationId, setOperationId] = useState('');
  const [guardedOperationId, setGuardedOperationId] = useState('');
  const [receiptOperationId, setReceiptOperationId] = useState('');
  const [catalog, setCatalog] = useState<PaykitGuideCatalog>();
  const [diagnostics, setDiagnostics] = useState<PaykitDiagnostics>();
  const [guideError, setGuideError] = useState('');
  const [guideView, setGuideView] = useState<PaykitGuideViewState>();
  const [guidePeer, setGuidePeer] = useState<PaykitGuidePeerFocus>();
  const [acknowledgedSteps, setAcknowledgedSteps] = useState<string[]>([]);
  const [activePage, setActivePage] = useState('workspace');
  const active = !!network.paykit && network.status === Status.Started;
  const guideStorageKey = network.paykit
    ? `paykit-guide:${network.paykit.environmentId}:${network.id}`
    : '';

  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    setState(undefined);
    setReceiptOperationId('');
    setGuardedOperationId('');
    setConnectionError('');
    const poll = async () => {
      try {
        const next = await paykitService.state(network.id);
        if (!disposed) {
          setState(next);
          setConnectionError('');
        }
        try {
          const nextDiagnostics = await paykitService.diagnostics(network.id);
          if (!disposed) setDiagnostics(nextDiagnostics);
        } catch (diagnosticError: any) {
          if (!disposed) setGuideError(diagnosticError.message);
        }
      } catch (e: any) {
        if (!disposed) setConnectionError(e.message);
      }
      if (!disposed) timer = setTimeout(poll, 1000);
    };
    if (active) poll();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [network.id, active]);

  useEffect(() => {
    let disposed = false;
    setCatalog(undefined);
    setDiagnostics(undefined);
    setGuideError('');
    if (!active) return () => undefined;
    Promise.resolve(paykitService.catalog(network.id))
      .then(nextCatalog => {
        if (!disposed) {
          setCatalog(nextCatalog);
        }
      })
      .catch((e: Error) => {
        if (!disposed) setGuideError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, [network.id, active]);

  useEffect(() => {
    setAcknowledgedSteps([]);
    setGuidePeer(undefined);
    setGuideView(undefined);
    if (!guideStorageKey) return;
    try {
      const saved = JSON.parse(localStorage.getItem(guideStorageKey) || 'null');
      if (
        saved &&
        typeof saved.scenarioId === 'string' &&
        typeof saved.stepId === 'string'
      ) {
        setGuideView({
          environmentId: network.paykit!.environmentId,
          networkId: network.id,
          scenarioId: saved.scenarioId,
          stepId: saved.stepId,
        });
        setActivePage('guides');
      }
    } catch (_) {
      localStorage.removeItem(guideStorageKey);
    }
  }, [guideStorageKey, network.id, network.paykit]);

  const navigateGuide = (scenarioId: string, stepId: string) => {
    if (!network.paykit) return;
    const next = {
      environmentId: network.paykit.environmentId,
      networkId: network.id,
      scenarioId,
      stepId,
    };
    setGuideView(next);
    localStorage.setItem(guideStorageKey, JSON.stringify({ scenarioId, stepId }));
  };
  const focusGuideReceiver = (id: string) => {
    const next = state?.receivers.find(item => item.id === id);
    if (!next) return;
    selectParticipant(next.participantId);
    selectReceiver(next.id);
    setParticipantName(
      state?.participants.find(item => item.id === next.participantId)?.name || '',
    );
    setReceiverName(next.name);
    setGuidePeer(undefined);
  };
  const openGuidePanel = (panelId: string) => {
    const page = panelId === 'receipts' ? 'proofs' : panelId;
    setActivePage(page);
    setTimeout(() => document.getElementById(`paykit-page-${page}`)?.scrollIntoView?.());
  };

  const perform = async (task: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await task();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const submit = async (request: PaykitCommandRequest) => {
    validatePaykitCommand(request);
    setRetry(request);
    try {
      const result = await paykitService.command(network.id, request);
      setOperationId(result.operationId);
      if (guardedCommand(request.command)) setGuardedOperationId(result.operationId);
      if (request.command.startsWith('receipt.'))
        setReceiptOperationId(result.operationId);
      setRetry(undefined);
    } catch (e: any) {
      // A rejected request was never accepted. Transport errors remain uncertain.
      if (
        /HTTP 4[0-9]{2}/.test(e.message) ||
        e.message.startsWith('Paykit command not submitted:')
      )
        setRetry(undefined);
      throw e;
    }
  };
  const command = (name: PaykitCommand, input: PaykitInput) =>
    perform(() => submit({ commandId: newPaykitId(), command: name, input }));
  const participant = state?.participants.find(p => p.id === participantId);
  const receivers = state?.receivers.filter(r => r.participantId === participantId) || [];
  const receiver = receivers.find(r => r.id === receiverId);
  const guardedPending =
    (!!guardedOperationId &&
      !state?.operations.some(
        item =>
          item.id === guardedOperationId && ['succeeded', 'failed'].includes(item.status),
      )) ||
    state?.operations.some(
      item => guardedCommand(item.command) && ['queued', 'running'].includes(item.status),
    );
  const disabled =
    busy || !state?.ready || !!retry || !!connectionError || !!guardedPending;
  const receiptPending =
    (!!receiptOperationId &&
      !state?.operations.some(
        item =>
          item.id === receiptOperationId && ['succeeded', 'failed'].includes(item.status),
      )) ||
    state?.operations.some(
      item =>
        item.command.startsWith('receipt.') &&
        (item.status === 'queued' || item.status === 'running'),
    );
  const fundingPending = state?.operations.some(
    item =>
      item.command === 'preset.fund' &&
      (item.status === 'queued' || item.status === 'running'),
  );
  const fundingRecovery =
    state?.funding &&
    (['uncertain', 'failed'].includes(state.funding.status) ||
      (state.funding.status === 'running' && !fundingPending));

  if (!network.paykit)
    return (
      <Card title="Paykit workspace">
        <p>
          Add a persistent local Pubky environment with participants and independently
          restartable receivers.
        </p>
        <p>Stop this network before enabling Paykit. Docker Desktop must be running.</p>
        {error && <Alert type="error" message={error} showIcon />}
        <PaykitImageSetup
          disabled={busy || network.status !== Status.Stopped}
          onReady={() => perform(() => enablePaykit(network.id))}
        />
      </Card>
    );
  return (
    <div style={{ overflow: 'auto', paddingBottom: 24 }}>
      <Tabs
        activeKey={activePage}
        onChange={setActivePage}
        items={workbenchPages.map(([key, label]) => ({ key, label }))}
      />
      <div
        id="paykit-page-workspace"
        style={{ display: activePage === 'workspace' ? 'block' : 'none' }}
      >
        <Card
          title="Paykit workspace"
          extra={
            <Tag color={state?.ready ? 'green' : 'default'}>
              {state?.ready ? 'Ready' : 'Not ready'}
            </Tag>
          }
        >
          {!active && <PaykitImageSetup />}
          <Typography.Paragraph>
            Each receiver has its own persistent SDK state. The preset creates Alice, Bob
            and Carol, including Bob’s wallet and server receivers.
          </Typography.Paragraph>
          {!active && (
            <Alert
              showIcon
              type="info"
              message={
                network.status === Status.Starting
                  ? 'Paykit environment is starting.'
                  : 'Start the network to use its Paykit workspace.'
              }
            />
          )}
          {network.status === Status.Error && (
            <Button loading={busy} onClick={() => perform(() => stop(network.id))}>
              Stop network and clean up services
            </Button>
          )}
          {error && <Alert role="alert" type="error" message={error} showIcon />}
          {connectionError && (
            <Alert role="alert" type="error" message={connectionError} showIcon />
          )}
          {retry && (
            <Alert
              type="warning"
              message="Command acceptance is uncertain. Retry the same command ID before submitting another action."
              action={
                <Button loading={busy} onClick={() => perform(() => submit(retry))}>
                  Retry command
                </Button>
              }
            />
          )}
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="Environment">
              {network.paykit.environmentId}
            </Descriptions.Item>
            <Descriptions.Item label="API version">
              {network.paykit.apiVersion}
            </Descriptions.Item>
            <Descriptions.Item label="Event sequence">
              {state?.lastEventSequence ?? 'Unavailable'}
            </Descriptions.Item>
          </Descriptions>
          <Button
            type="primary"
            disabled={disabled || fundingPending}
            onClick={() => command('preset.fund', {})}
          >
            {fundingRecovery
              ? 'Recover funded preset'
              : 'Create funded Alice / Bob / Carol preset'}
          </Button>
          {state?.funding && (
            <div style={{ marginTop: 12 }}>
              <Typography.Paragraph>
                Funding: {state.funding.status} · {state.funding.step}
              </Typography.Paragraph>
              {state.funding.lastError && (
                <Alert type="error" message={state.funding.lastError} />
              )}
              <List
                dataSource={state.funding.wallets}
                renderItem={item => (
                  <List.Item>
                    {item.participant}: {item.onchainBalanceSats} on-chain sats ·{' '}
                    {item.lightningBalanceSats} Lightning wallet sats ({item.walletId})
                  </List.Item>
                )}
              />
              <Typography.Paragraph>
                {state.funding.funded
                  ? 'Funded wallets and channels are ready.'
                  : 'Funding is not yet verified.'}
              </Typography.Paragraph>
            </div>
          )}
          <Button disabled={disabled} onClick={() => command('preset.create', {})}>
            Create Alice / Bob / Carol preset
          </Button>
        </Card>
      </div>
      <div
        id="paykit-page-guides"
        style={{ display: activePage === 'guides' ? 'block' : 'none' }}
      >
        {guideError && (
          <Alert
            style={{ marginTop: 12 }}
            type="warning"
            showIcon
            message="Guided scenarios are unavailable"
            description={guideError}
          />
        )}
        {catalog && state && (
          <PaykitGuidedScenarios
            catalog={catalog}
            diagnostics={diagnostics}
            participants={state.participants}
            receivers={state.receivers}
            viewState={guideView}
            selectedReceiverId={receiverId}
            selectedPeer={guidePeer}
            acknowledgedStepIds={acknowledgedSteps}
            pendingOperationId={operationId || undefined}
            onNavigate={navigateGuide}
            onSelectReceiver={focusGuideReceiver}
            onSelectPeer={setGuidePeer}
            onOpenPanel={openGuidePanel}
            onAcknowledgeStep={(scenarioId, stepId) =>
              setAcknowledgedSteps(current => [
                ...new Set([...current, `${scenarioId}:${stepId}`]),
              ])
            }
          />
        )}
      </div>
      <div style={{ display: activePage === 'workspace' ? 'block' : 'none' }}>
        <div id="paykit-workspace-controls">
          <Card title="Participants" style={{ marginTop: 12 }}>
            <Space wrap>
              <Select
                aria-label="Participant"
                placeholder="Select participant"
                style={{ minWidth: 200 }}
                value={participantId}
                onChange={id => {
                  selectParticipant(id);
                  selectReceiver(undefined);
                  setReceiverName('');
                  setParticipantName(
                    state?.participants.find(p => p.id === id)?.name || '',
                  );
                }}
              >
                {state?.participants.map(p => (
                  <Select.Option key={p.id} value={p.id}>
                    {p.name}
                  </Select.Option>
                ))}
              </Select>
              <Input
                aria-label="Participant name"
                placeholder="Participant name"
                value={participantName}
                maxLength={80}
                onChange={e => setParticipantName(e.target.value)}
              />
              <Button
                disabled={disabled || !participantName.trim()}
                onClick={() =>
                  command('participant.create', { name: participantName.trim() })
                }
              >
                Create participant
              </Button>
              <Button
                disabled={disabled || !participant || !participantName.trim()}
                onClick={() =>
                  participant &&
                  command('participant.rename', {
                    participantId: participant.id,
                    name: participantName.trim(),
                  })
                }
              >
                Rename participant
              </Button>
            </Space>
            {participant && (
              <Typography.Paragraph style={{ marginTop: 12 }}>
                Public key:{' '}
                <Typography.Text copyable>{participant.publicKey}</Typography.Text>
              </Typography.Paragraph>
            )}
          </Card>
        </div>
        <Card title="Receivers" style={{ marginTop: 12 }}>
          <Space wrap>
            <Select
              aria-label="Receiver"
              placeholder="Select receiver"
              style={{ minWidth: 200 }}
              value={receiverId}
              onChange={id => {
                selectReceiver(id);
                setReceiverName(receivers.find(r => r.id === id)?.name || '');
              }}
            >
              {receivers.map(r => (
                <Select.Option key={r.id} value={r.id}>
                  {r.name} ({r.status})
                </Select.Option>
              ))}
            </Select>
            <Input
              aria-label="Receiver name"
              placeholder="Receiver name"
              value={receiverName}
              maxLength={80}
              onChange={e => setReceiverName(e.target.value)}
            />
            <Select
              aria-label="Receiver kind"
              value={kind}
              onChange={setKind}
              style={{ minWidth: 100 }}
            >
              <Select.Option value="wallet">Wallet</Select.Option>
              <Select.Option value="server">Server</Select.Option>
            </Select>
            <Button
              disabled={disabled || !participant || !receiverName.trim()}
              onClick={() =>
                participant &&
                command('receiver.create', {
                  participantId: participant.id,
                  name: receiverName.trim(),
                  kind,
                })
              }
            >
              Create receiver
            </Button>
            <Button
              disabled={disabled || !receiver || !receiverName.trim()}
              onClick={() =>
                receiver &&
                command('receiver.rename', {
                  receiverId: receiver.id,
                  name: receiverName.trim(),
                })
              }
            >
              Rename receiver
            </Button>
          </Space>
          {receiver && (
            <>
              <Descriptions column={1} size="small" style={{ marginTop: 12 }}>
                <Descriptions.Item label="Receiver path">
                  {receiver.path}
                </Descriptions.Item>
                <Descriptions.Item label="Status">{receiver.status}</Descriptions.Item>
                <Descriptions.Item label="Generation">
                  {receiver.generation}
                </Descriptions.Item>
                <Descriptions.Item label="Noise public key">
                  <Typography.Text copyable>{receiver.noisePublicKey}</Typography.Text>
                </Descriptions.Item>
              </Descriptions>
              {receiver.lastError && <Alert type="error" message={receiver.lastError} />}
              <Space>
                {(['start', 'stop', 'restart'] as const).map(action => (
                  <Button
                    key={action}
                    disabled={disabled}
                    onClick={() =>
                      command(`receiver.${action}`, { receiverId: receiver.id })
                    }
                  >
                    {action[0].toUpperCase() + action.slice(1)} receiver
                  </Button>
                ))}
              </Space>
            </>
          )}
        </Card>
      </div>
      {receiver && state && (
        <div key={`${network.id}:${receiver.id}`}>
          <Typography.Paragraph style={{ marginTop: 12 }}>
            Receiver workspace:{' '}
            <strong>
              {participant?.name} / {receiver.name}
            </strong>{' '}
            — {receiver.path}
          </Typography.Paragraph>
          <div
            id="paykit-page-links"
            style={{ display: activePage === 'links' ? 'block' : 'none' }}
          >
            <PaykitLinks
              receiverId={receiver.id}
              workspace={state.receiverWorkspaces?.find(
                item => item.receiverId === receiver.id,
              )}
              state={state}
              disabled={disabled || receiver.status !== 'running'}
              command={command}
            />
          </div>
          <div
            id="paykit-page-methods"
            style={{ display: activePage === 'methods' ? 'block' : 'none' }}
          >
            <PaykitPaymentMethods
              receiverId={receiver.id}
              workspace={state.receiverWorkspaces?.find(
                item => item.receiverId === receiver.id,
              )}
              state={state}
              disabled={disabled || receiver.status !== 'running'}
              command={command}
            />
          </div>
          <div
            id="paykit-page-requests"
            style={{ display: activePage === 'requests' ? 'block' : 'none' }}
          >
            <PaykitRequests
              receiverId={receiver.id}
              workspace={state.receiverWorkspaces?.find(
                item => item.receiverId === receiver.id,
              )}
              state={state}
              disabled={disabled || receiver.status !== 'running'}
              command={command}
            />
          </div>
          <div
            id="paykit-page-subscriptions"
            style={{ display: activePage === 'subscriptions' ? 'block' : 'none' }}
          >
            <PaykitSubscriptions
              receiverId={receiver.id}
              workspace={state.receiverWorkspaces?.find(
                item => item.receiverId === receiver.id,
              )}
              state={state}
              disabled={disabled || receiver.status !== 'running'}
              command={command}
            />
          </div>
          <div
            id="paykit-page-proofs"
            style={{ display: activePage === 'proofs' ? 'block' : 'none' }}
          >
            <PaykitProofs
              receiverId={receiver.id}
              workspace={state.receiverWorkspaces?.find(
                item => item.receiverId === receiver.id,
              )}
              disabled={disabled || receiver.status !== 'running'}
              command={command}
            />
            <PaykitReceipts
              receiverId={receiver.id}
              workspace={state.receiverWorkspaces?.find(
                item => item.receiverId === receiver.id,
              )}
              disabled={disabled || receiver.status !== 'running' || !!receiptPending}
              command={command}
            />
          </div>
          <div
            id="paykit-page-profiles"
            style={{ display: activePage === 'profiles' ? 'block' : 'none' }}
          >
            <PaykitProfilesContacts
              receiverId={receiver.id}
              workspace={state.receiverWorkspaces?.find(
                item => item.receiverId === receiver.id,
              )}
              disabled={disabled || receiver.status !== 'running'}
              command={command}
            />
          </div>
          <div
            id="paykit-page-backup"
            style={{ display: activePage === 'backup' ? 'block' : 'none' }}
          >
            <PaykitBackupRecovery
              networkId={network.id}
              receiver={receiver}
              workspace={state.receiverWorkspaces?.find(
                item => item.receiverId === receiver.id,
              )}
              disabled={disabled}
              command={command}
            />
          </div>
        </div>
      )}
      <Card title="Operations" style={{ marginTop: 12 }}>
        {operationId && (
          <Typography.Paragraph>
            Last accepted operation: {operationId}
          </Typography.Paragraph>
        )}
        <List
          dataSource={state?.operations.slice().reverse() || []}
          locale={{ emptyText: 'No operations yet' }}
          renderItem={operation => (
            <List.Item>
              <div>
                <Tag
                  color={
                    operation.status === 'failed'
                      ? 'red'
                      : operation.status === 'succeeded'
                      ? 'green'
                      : 'blue'
                  }
                >
                  {operation.status}
                </Tag>
                {operation.command}
                <br />
                <Typography.Text type="secondary">{operation.id}</Typography.Text>
                {operation.result !== undefined && (
                  <pre
                    aria-label="Public operation result"
                    style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                  >
                    {JSON.stringify(operation.result, null, 2)}
                  </pre>
                )}
                {operation.error && (
                  <Alert
                    type="error"
                    message={`${operation.error.code}: ${operation.error.message}`}
                  />
                )}
              </div>
            </List.Item>
          )}
        />
      </Card>
    </div>
  );
};
export default PaykitWorkspace;
