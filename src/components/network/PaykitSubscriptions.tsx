import React, { useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Input,
  List,
  Select,
  Space,
  Tag,
  Typography,
} from 'antd';
import {
  isPaykitUtcInstant,
  PaykitMethod,
  PaykitRecurrence,
  paykitMethods,
  paykitRecurrenceUnits,
  PaykitState,
} from 'shared/paykitApi';
import { PaykitReceiverPanelProps } from './PaykitLinks';

const PaykitSubscriptions: React.FC<
  PaykitReceiverPanelProps & { state: PaykitState }
> = ({ receiverId, workspace, disabled, command, state }) => {
  const [peerPublicKey, setPeerKey] = useState('');
  const [peerReceiverPath, setPeerPath] = useState('');
  const [amount, setAmount] = useState('1000');
  const [description, setDescription] = useState('');
  const [methods, setMethods] = useState<string[]>([]);
  const [every, setEvery] = useState('1');
  const [unit, setUnit] = useState<PaykitRecurrence['unit']>('month');
  const [anchor, setAnchor] = useState('');
  const [end, setEnd] = useState('');
  const [expiry, setExpiry] = useState('3600');
  const [requestId, setRequest] = useState('');
  const [index, setIndex] = useState('0');
  const [source, setSource] = useState<'public' | 'private'>();
  const [walletId, setWallet] = useState('');
  const [method, setMethod] = useState<PaykitMethod>();
  const [now, setNow] = useState('');
  const requests = (workspace?.requests || []).filter(item => item.recurrence);
  const selected = requests.find(item => item.id === requestId);
  const subscription = workspace?.subscriptions?.find(
    item => item.requestId === requestId,
  );
  const periodIndex = Number(index);
  const validIndex =
    /^\d+$/.test(index) &&
    Number.isInteger(periodIndex) &&
    periodIndex >= 0 &&
    periodIndex <= 10000;
  const period = subscription?.periods.find(item => item.index === periodIndex);
  const active =
    !!selected && ['accepted', 'activeRecurring'].includes(selected.lifecycle);
  const wallet = workspace?.paymentMethods?.wallets.find(item => item.id === walletId);
  const preference = workspace?.paymentMethods?.preference || [];
  const methodAvailable = (method ? [method] : preference).some(
    item =>
      selected?.acceptedMethods.includes(item) &&
      wallet?.supportedMethods.includes(item) &&
      (period?.endpointCommitments ?? period?.endpointBindings)?.some(
        binding => binding.source === source && binding.method === item,
      ),
  );
  const periodExecuted =
    !!period?.executionId ||
    workspace?.executions?.some(
      item => item.requestId === requestId && item.periodIndex === periodIndex,
    );
  const clock = workspace?.applicationClock;
  const effectiveNow = clock?.now || new Date().toISOString();
  const hasStarted =
    validIndex &&
    (period
      ? Date.parse(period.startsAt) <= Date.parse(effectiveNow)
      : subscription?.currentPeriodIndex != null
      ? periodIndex <= subscription.currentPeriodIndex
      : !!selected?.recurrence &&
        Date.parse(selected.recurrence.startsAt) <= Date.parse(effectiveNow));
  const canReset = clock?.mode === 'controlled' && Date.parse(clock.now) <= Date.now();
  const authorizationValid =
    !!method &&
    !!wallet &&
    wallet.supportedMethods.includes(method) &&
    !!selected?.acceptedMethods.includes(method);
  return (
    <Card title="Subscriptions and billing periods" style={{ marginTop: 12 }}>
      <Typography.Paragraph>
        Agree to fixed satoshi amounts for full UTC anchored periods. Monthly and yearly
        dates clamp to the last available day. There is no proration. Missed periods
        require manual payment; enabling autopay never collects a backlog.
      </Typography.Paragraph>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Title level={5}>Compose recurring request</Typography.Title>
        <Select
          aria-label="Subscription payer receiver"
          placeholder="Choose a local payer receiver"
          style={{ minWidth: 320 }}
          onChange={(id: string) => {
            const receiver = state.receivers.find(item => item.id === id);
            const participant = state.participants.find(
              item => item.id === receiver?.participantId,
            );
            if (receiver && participant) {
              setPeerKey(participant.publicKey);
              setPeerPath(receiver.path);
            }
          }}
        >
          {state.receivers
            .filter(
              item =>
                item.participantId !==
                state.receivers.find(receiver => receiver.id === receiverId)
                  ?.participantId,
            )
            .map(item => (
              <Select.Option key={item.id} value={item.id}>
                {
                  state.participants.find(
                    participant => participant.id === item.participantId,
                  )?.name
                }{' '}
                / {item.name}
              </Select.Option>
            ))}
        </Select>
        <Input
          aria-label="Subscription payer public key"
          placeholder="Payer public key"
          value={peerPublicKey}
          onChange={event => setPeerKey(event.target.value)}
        />
        <Input
          aria-label="Subscription payer receiver path"
          placeholder="Payer receiver path"
          value={peerReceiverPath}
          onChange={event => setPeerPath(event.target.value)}
        />
        <Input
          aria-label="Subscription amount sats"
          addonAfter="sats per period"
          value={amount}
          onChange={event => setAmount(event.target.value)}
        />
        <Input
          aria-label="Subscription description"
          placeholder="Description"
          value={description}
          onChange={event => setDescription(event.target.value)}
        />
        <Select
          mode="multiple"
          aria-label="Subscription accepted methods"
          placeholder="Accepted methods"
          value={methods}
          onChange={setMethods}
          style={{ minWidth: 320 }}
        >
          {paykitMethods.map(item => (
            <Select.Option key={item} value={item}>
              {item}
            </Select.Option>
          ))}
        </Select>
        <Input
          aria-label="Subscription recurrence interval"
          addonBefore="Every"
          value={every}
          onChange={event => setEvery(event.target.value)}
        />
        <Select aria-label="Subscription recurrence unit" value={unit} onChange={setUnit}>
          {paykitRecurrenceUnits.map(item => (
            <Select.Option key={item} value={item}>
              {item}
            </Select.Option>
          ))}
        </Select>
        <Input
          aria-label="Subscription UTC anchor"
          placeholder="Start / anchor: YYYY-MM-DDTHH:mm:ssZ"
          value={anchor}
          onChange={event => setAnchor(event.target.value)}
        />
        <Input
          aria-label="Subscription UTC end"
          placeholder="Optional end at a full period boundary: YYYY-MM-DDTHH:mm:ssZ"
          value={end}
          onChange={event => setEnd(event.target.value)}
        />
        <Input
          aria-label="Subscription proposal expiry seconds"
          addonAfter="seconds until proposal expires"
          value={expiry}
          onChange={event => setExpiry(event.target.value)}
        />
        <Button
          disabled={
            disabled ||
            !peerPublicKey.trim() ||
            !peerReceiverPath.trim() ||
            !description.trim() ||
            !methods.length ||
            !isPaykitUtcInstant(anchor) ||
            (!!end && !isPaykitUtcInstant(end))
          }
          onClick={() =>
            command('request.create', {
              receiverId,
              peerPublicKey: peerPublicKey.trim(),
              peerReceiverPath: peerReceiverPath.trim(),
              amountSats: amount,
              description: description.trim(),
              acceptedMethods: methods,
              expirySeconds: Number(expiry),
              recurrence: {
                every: Number(every),
                unit,
                startsAt: anchor,
                anchor,
                endsAt: end || null,
              },
            })
          }
        >
          Create recurring request
        </Button>
        <List
          dataSource={requests}
          locale={{ emptyText: 'No recurring requests' }}
          renderItem={item => (
            <List.Item>
              <div>
                <Typography.Text strong>{item.description}</Typography.Text> ·{' '}
                {item.amountSats} sats every {item.recurrence!.every}{' '}
                {item.recurrence!.unit} · <Tag>{item.lifecycle}</Tag>
                <Descriptions size="small" column={1}>
                  <Descriptions.Item label="Subscription request">
                    {item.id}
                  </Descriptions.Item>
                  <Descriptions.Item label="Role">{item.role}</Descriptions.Item>
                  <Descriptions.Item label="UTC anchor">
                    {item.recurrence!.anchor}
                  </Descriptions.Item>
                  <Descriptions.Item label="UTC end">
                    {item.recurrence!.endsAt || 'Open ended'}
                  </Descriptions.Item>
                  <Descriptions.Item label="Accepted methods">
                    {item.acceptedMethods.join(', ')}
                  </Descriptions.Item>
                  <Descriptions.Item label="Delivery">
                    {item.deliveryStatus}
                  </Descriptions.Item>
                </Descriptions>
                <Space wrap>
                  {item.role === 'payer' && (
                    <>
                      <Button
                        disabled={disabled || item.lifecycle !== 'proposed'}
                        onClick={() =>
                          command('request.accept', { receiverId, requestId: item.id })
                        }
                      >
                        Accept recurring terms
                      </Button>
                      <Button
                        disabled={disabled || item.lifecycle !== 'proposed'}
                        onClick={() =>
                          command('request.reject', { receiverId, requestId: item.id })
                        }
                      >
                        Reject recurring terms
                      </Button>
                    </>
                  )}
                  <Button
                    disabled={
                      disabled ||
                      !['proposed', 'accepted', 'activeRecurring'].includes(
                        item.lifecycle,
                      )
                    }
                    onClick={() =>
                      command('request.cancel', { receiverId, requestId: item.id })
                    }
                  >
                    Cancel subscription
                  </Button>
                </Space>
              </div>
            </List.Item>
          )}
        />
        <Typography.Title level={5}>Manage a billing period</Typography.Title>
        <Select
          aria-label="Subscription request"
          placeholder="Select recurring request"
          value={requestId || undefined}
          onChange={id => {
            setRequest(id);
            setIndex('0');
            setSource(undefined);
            setWallet('');
            setMethod(undefined);
          }}
          style={{ minWidth: 320 }}
        >
          {requests.map(item => (
            <Select.Option key={item.id} value={item.id}>
              {item.description} · {item.role} · {item.id}
            </Select.Option>
          ))}
        </Select>
        {subscription && (
          <>
            <Typography.Paragraph>
              Current period:{' '}
              {subscription.currentPeriodIndex ?? 'Outside the subscription schedule'} ·
              Autopay: {subscription.autopay.enabled ? 'Enabled' : 'Disabled'} ·{' '}
              {subscription.autopay.status}
            </Typography.Paragraph>
            {subscription.autopay.enabled && (
              <Typography.Paragraph>
                Authorized wallet: {subscription.autopay.walletId} ·{' '}
                {subscription.autopay.source} · {subscription.autopay.method}
              </Typography.Paragraph>
            )}
            {subscription.autopay.lastError && (
              <Alert type="error" message={subscription.autopay.lastError} />
            )}
            <List
              dataSource={subscription.periods}
              locale={{ emptyText: 'No elapsed billing periods' }}
              renderItem={item => (
                <List.Item>
                  <div>
                    Period {item.index} · {item.startsAt} → {item.endsAt} ·{' '}
                    <Tag>{item.status}</Tag>
                    <br />
                    Execution: {item.executionId || 'None'} · Proof:{' '}
                    {item.proofId || 'None'}
                    {item.endpointBindings.map(binding => (
                      <div key={binding.reservationId}>
                        <Tag>{binding.source}</Tag>
                        {binding.method}:{' '}
                        <Typography.Text copyable style={{ overflowWrap: 'anywhere' }}>
                          {binding.endpoint}
                        </Typography.Text>
                      </div>
                    ))}
                    {item.endpointCommitments
                      ?.filter(
                        commitment =>
                          !item.endpointBindings.some(
                            binding =>
                              binding.reservationId === commitment.reservationId &&
                              binding.source === commitment.source &&
                              binding.method === commitment.method,
                          ),
                      )
                      .map(commitment => (
                        <div key={commitment.reservationId}>
                          <Tag>{commitment.source}</Tag>
                          {commitment.method} · Endpoint SHA-256:{' '}
                          <Typography.Text copyable style={{ overflowWrap: 'anywhere' }}>
                            {commitment.endpointHash}
                          </Typography.Text>
                          <Typography.Paragraph type="secondary">
                            The wallet endpoint will be resolved and checked against this
                            commitment before payment.
                          </Typography.Paragraph>
                        </div>
                      ))}
                    {item.lastError && <Alert type="error" message={item.lastError} />}
                    <Button
                      disabled={disabled}
                      onClick={() => setIndex(String(item.index))}
                    >
                      Select period {item.index}
                    </Button>
                  </div>
                </List.Item>
              )}
            />
          </>
        )}
        <Input
          aria-label="Subscription period index"
          addonBefore="Period index (zero based)"
          value={index}
          onChange={event => setIndex(event.target.value)}
        />
        <Typography.Paragraph>
          Enter an older period index if it is outside the displayed history. Prepare its
          fresh endpoints as payee, then select it as payer. Payment, proof verification
          and receipt issuance remain separate.
        </Typography.Paragraph>
        <Select
          aria-label="Subscription endpoint source"
          placeholder="Choose public or private"
          value={source}
          onChange={setSource}
        >
          <Select.Option value="public">Public</Select.Option>
          <Select.Option value="private">Private</Select.Option>
        </Select>
        {selected?.role === 'payee' && (
          <>
            <Input
              aria-label="Subscription endpoint expiry seconds"
              addonAfter="seconds until receiving endpoints expire"
              value={expiry}
              onChange={event => setExpiry(event.target.value)}
            />
            <Button
              disabled={
                disabled ||
                !active ||
                !hasStarted ||
                !source ||
                !!period?.offerId ||
                !!periodExecuted
              }
              onClick={() =>
                source &&
                command('subscription.prepare', {
                  receiverId,
                  requestId,
                  periodIndex,
                  source,
                  expirySeconds: Number(expiry),
                })
              }
            >
              Prepare period endpoints
            </Button>
            <Typography.Paragraph>
              Uses the receiving wallet and enabled methods configured in Payment methods.
              Prepared endpoints belong only to this period.
            </Typography.Paragraph>
          </>
        )}
        {selected?.role === 'payer' && (
          <>
            <Select
              aria-label="Subscription spending wallet"
              placeholder="Choose spending wallet"
              value={walletId || undefined}
              onChange={setWallet}
            >
              {workspace?.paymentMethods?.wallets.map(item => (
                <Select.Option key={item.id} value={item.id}>
                  {item.label}
                </Select.Option>
              ))}
            </Select>
            <Select
              aria-label="Subscription payment method"
              placeholder={
                preference.length
                  ? `Saved preference: ${preference.join(', ')}`
                  : 'Choose a payment method'
              }
              allowClear
              value={method}
              onChange={setMethod}
            >
              {paykitMethods.map(item => (
                <Select.Option
                  key={item}
                  value={item}
                  disabled={
                    !selected.acceptedMethods.includes(item) ||
                    !wallet?.supportedMethods.includes(item)
                  }
                >
                  {item}
                </Select.Option>
              ))}
            </Select>
            {!period?.offerId && (
              <Alert
                type="info"
                message="Waiting for the payee’s period offer. No payment can execute until its fresh endpoints arrive."
              />
            )}
            {periodExecuted && (
              <Alert
                type="info"
                message="This period already has an execution. Inspect or reconcile its original execution in Requests and payments; another payment is blocked."
              />
            )}
            <Button
              type="primary"
              disabled={
                disabled ||
                !active ||
                !hasStarted ||
                !source ||
                !walletId ||
                !methodAvailable ||
                !period?.offerId ||
                !!periodExecuted
              }
              onClick={() =>
                source &&
                command('payment.execute', {
                  receiverId,
                  requestId,
                  periodIndex,
                  source,
                  walletId,
                  ...(method ? { method } : {}),
                })
              }
            >
              Pay selected period manually
            </Button>
            <Alert
              type="info"
              message="Autopay is an explicit authorization for this request only. It attempts the current period when an offer arrives and submits its payment proof. Missed periods and failed or uncertain attempts need manual attention. Settlement verification and receipts remain separate."
            />
            <Button
              disabled={
                disabled ||
                !active ||
                !source ||
                !authorizationValid ||
                subscription?.autopay.enabled
              }
              onClick={() =>
                source &&
                method &&
                command('subscription.authorize', {
                  receiverId,
                  requestId,
                  walletId,
                  source,
                  method,
                })
              }
            >
              Enable autopay for this request
            </Button>
            <Button
              disabled={disabled || !subscription?.autopay.enabled}
              onClick={() => command('subscription.disable', { receiverId, requestId })}
            >
              Disable autopay for this request
            </Button>
          </>
        )}
        <Typography.Title level={5}>Receiver application clock</Typography.Title>
        <Typography.Paragraph>
          Effective UTC time: {effectiveNow} · {clock?.mode || 'system'}. Controls affect
          only this receiver’s SDK and application schedule. Wallet invoice expiry and
          Bitcoin time remain independent. Advancing time may trigger explicitly
          authorized autopay for the new current period.
        </Typography.Paragraph>
        <Input
          aria-label="Receiver application UTC time"
          placeholder="YYYY-MM-DDTHH:mm:ssZ"
          value={now}
          onChange={event => setNow(event.target.value)}
        />
        <Button
          disabled={
            disabled ||
            !isPaykitUtcInstant(now) ||
            Date.parse(now) < Date.parse(effectiveNow)
          }
          onClick={() => command('clock.set', { receiverId, now })}
        >
          Set receiver application time
        </Button>
        <Button
          disabled={disabled || !canReset}
          onClick={() => command('clock.reset', { receiverId })}
        >
          Return receiver to system time
        </Button>
        {clock?.mode === 'controlled' && !canReset && (
          <Alert
            type="info"
            message="System time is behind this receiver’s application time. Reset is blocked until system time catches up."
          />
        )}
      </Space>
    </Card>
  );
};
export default PaykitSubscriptions;
