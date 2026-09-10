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
import { PaykitMethod, paykitMethods, PaykitState } from 'shared/paykitApi';
import { PaykitReceiverPanelProps } from './PaykitLinks';

const PaykitRequests: React.FC<PaykitReceiverPanelProps & { state: PaykitState }> = ({
  receiverId,
  workspace,
  disabled,
  command,
  state,
}) => {
  const [peerPublicKey, setPeerKey] = useState('');
  const [peerReceiverPath, setPeerPath] = useState('');
  const [amountSats, setAmount] = useState('1000');
  const [description, setDescription] = useState('');
  const [expiry, setExpiry] = useState('3600');
  const [acceptedMethods, setAcceptedMethods] = useState<string[]>([]);
  const [requestId, setRequest] = useState('');
  const [walletId, setWallet] = useState('');
  const [source, setSource] = useState<'public' | 'private'>();
  const [method, setMethod] = useState<PaykitMethod>();
  const requests = workspace?.requests || [];
  const selected = requests.find(item => item.id === requestId);
  const executions = workspace?.executions || [];
  const hasExecution = executions.some(item => item.requestId === requestId);
  const preference = workspace?.paymentMethods?.preference || [];
  const wallet = workspace?.paymentMethods?.wallets.find(item => item.id === walletId);
  const availableMethod = (method ? [method] : preference).some(
    item =>
      selected?.acceptedMethods.includes(item) &&
      wallet?.supportedMethods.includes(item) &&
      selected.endpointBindings.some(
        binding => binding.source === source && binding.method === item,
      ),
  );
  const claimed = new Set(
    requests.flatMap(item => item.endpointBindings || []).map(item => item.reservationId),
  );
  const eligible = (workspace?.reservations || []).filter(
    item =>
      item.status === 'active' &&
      item.amountSats === amountSats &&
      !!item.endpoint &&
      Date.parse(item.expiresAt) > Date.now() &&
      !claimed.has(item.id) &&
      (item.source === 'public' ||
        (item.peerPublicKey === peerPublicKey.trim() &&
          item.peerReceiverPath === peerReceiverPath.trim())),
  );
  const missingMethods = acceptedMethods.filter(
    item => !eligible.some(reservation => reservation.method === item),
  );
  const hasBindings = (item: (typeof requests)[number]) =>
    item.acceptedMethods.length > 0 &&
    item.acceptedMethods.every(method =>
      item.endpointBindings?.some(binding => binding.method === method),
    );
  const local = state.receivers.find(item => item.id === receiverId);
  return (
    <Card title="Requests and payments" style={{ marginTop: 12 }}>
      <Typography.Paragraph>
        Create a request as the payee. The payer accepts its terms, selects an endpoint
        and sends a payment explicitly. Proof delivery and settlement verification are
        separate steps.
      </Typography.Paragraph>
      <Alert
        type="info"
        showIcon
        message="Before composing, publish or rotate fresh receiving endpoints for this exact amount and every accepted method. Private reservations must name this payer receiver. An endpoint already claimed by another request cannot be reused."
      />
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select
          aria-label="Request payer receiver"
          placeholder="Choose a local payer receiver"
          style={{ minWidth: 320 }}
          onChange={(id: string) => {
            const peer = state.receivers.find(item => item.id === id);
            const participant = state.participants.find(
              item => item.id === peer?.participantId,
            );
            if (peer && participant) {
              setPeerKey(participant.publicKey);
              setPeerPath(peer.path);
            }
          }}
        >
          {state.receivers
            .filter(item => item.participantId !== local?.participantId)
            .map(item => (
              <Select.Option key={item.id} value={item.id}>
                {state.participants.find(p => p.id === item.participantId)?.name} /{' '}
                {item.name}
              </Select.Option>
            ))}
        </Select>
        <Input
          aria-label="Request payer public key"
          placeholder="Payer public key"
          value={peerPublicKey}
          onChange={e => setPeerKey(e.target.value)}
        />
        <Input
          aria-label="Request payer receiver path"
          placeholder="Payer receiver path"
          value={peerReceiverPath}
          onChange={e => setPeerPath(e.target.value)}
        />
        <Input
          aria-label="Request amount sats"
          addonAfter="sats"
          value={amountSats}
          onChange={e => setAmount(e.target.value)}
        />
        <Input.TextArea
          aria-label="Request description"
          placeholder="Description"
          value={description}
          onChange={e => setDescription(e.target.value)}
        />
        <Input
          aria-label="Request proposal expiry seconds"
          addonAfter="seconds until proposal expires"
          value={expiry}
          onChange={e => setExpiry(e.target.value)}
        />
        <Select
          mode="multiple"
          aria-label="Request accepted methods"
          placeholder="Accepted methods"
          value={acceptedMethods}
          onChange={setAcceptedMethods}
          style={{ minWidth: 320 }}
        >
          {paykitMethods.map(item => (
            <Select.Option key={item} value={item}>
              {item}
            </Select.Option>
          ))}
        </Select>
        {missingMethods.length > 0 && (
          <Alert
            type="warning"
            message={`Publish or rotate fresh receiving endpoints for: ${missingMethods.join(
              ', ',
            )} (${amountSats} sats). Use Payment methods and reservations above.`}
          />
        )}
        <Button
          disabled={
            disabled ||
            missingMethods.length > 0 ||
            !description.trim() ||
            !peerPublicKey.trim() ||
            !peerReceiverPath.trim() ||
            !acceptedMethods.length
          }
          onClick={() =>
            command('request.create', {
              receiverId,
              peerPublicKey: peerPublicKey.trim(),
              peerReceiverPath: peerReceiverPath.trim(),
              amountSats,
              description: description.trim(),
              expirySeconds: Number(expiry),
              acceptedMethods,
            })
          }
        >
          Create payment request
        </Button>
        <List
          dataSource={requests.slice().reverse()}
          locale={{ emptyText: 'No payment requests' }}
          renderItem={item => (
            <List.Item>
              <div>
                <Typography.Text strong>{item.description}</Typography.Text> ·{' '}
                {item.amountSats} sats
                <Descriptions size="small" column={1}>
                  <Descriptions.Item label="Request">{item.id}</Descriptions.Item>
                  <Descriptions.Item label="Role">{item.role}</Descriptions.Item>
                  <Descriptions.Item label="Peer">
                    {item.peerPublicKey} / {item.peerReceiverPath}
                  </Descriptions.Item>
                  <Descriptions.Item label="Request lifecycle">
                    <Tag>{item.lifecycle}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="Request delivery">
                    {item.deliveryStatus}
                  </Descriptions.Item>
                  <Descriptions.Item label="Proposal expiry">
                    {item.proposalExpiresAt || 'No proposal expiry recorded'}
                  </Descriptions.Item>
                  <Descriptions.Item label="Accepted methods">
                    {item.acceptedMethods.join(', ')}
                  </Descriptions.Item>
                  <Descriptions.Item label="Immutable receiving endpoints">
                    <Space direction="vertical">
                      {item.endpointBindings?.map(binding => (
                        <div key={binding.reservationId}>
                          <Tag>{binding.source}</Tag>
                          {binding.method}
                          <br />
                          <Typography.Text copyable style={{ overflowWrap: 'anywhere' }}>
                            {binding.endpoint}
                          </Typography.Text>
                          <br />
                          <Typography.Text type="secondary">
                            Reservation {binding.reservationId}
                          </Typography.Text>
                        </div>
                      ))}
                    </Space>
                  </Descriptions.Item>
                  <Descriptions.Item label="Payment reference">
                    {item.paymentReference}
                  </Descriptions.Item>
                </Descriptions>
                {!hasBindings(item) && (
                  <Alert
                    type="warning"
                    message="This request has no complete valid endpoint bindings. Ask the payee to publish fresh endpoints and create a new request."
                  />
                )}
                <Space wrap>
                  {item.role === 'payer' && (
                    <>
                      <Button
                        disabled={
                          disabled || item.lifecycle !== 'proposed' || !hasBindings(item)
                        }
                        onClick={() =>
                          command('request.accept', { receiverId, requestId: item.id })
                        }
                      >
                        Accept request
                      </Button>
                      <Button
                        disabled={disabled || item.lifecycle !== 'proposed'}
                        onClick={() =>
                          command('request.reject', { receiverId, requestId: item.id })
                        }
                      >
                        Reject request
                      </Button>
                    </>
                  )}
                  <Button
                    disabled={
                      disabled || !['proposed', 'accepted'].includes(item.lifecycle)
                    }
                    onClick={() =>
                      command('request.cancel', { receiverId, requestId: item.id })
                    }
                  >
                    Cancel request
                  </Button>
                </Space>
              </div>
            </List.Item>
          )}
        />
        <Typography.Title level={5}>Send a payment</Typography.Title>
        <Select
          aria-label="Payment request"
          placeholder="Select an accepted request"
          value={requestId || undefined}
          onChange={setRequest}
          style={{ minWidth: 320 }}
        >
          {requests
            .filter(item => item.role === 'payer')
            .map(item => (
              <Select.Option key={item.id} value={item.id}>
                {item.description} · {item.amountSats} sats · {item.lifecycle}
              </Select.Option>
            ))}
        </Select>
        <Select
          aria-label="Spending wallet"
          placeholder="Select spending wallet"
          value={walletId || undefined}
          onChange={setWallet}
          style={{ minWidth: 320 }}
        >
          {workspace?.paymentMethods?.wallets.map(item => (
            <Select.Option key={item.id} value={item.id}>
              {item.label}
            </Select.Option>
          ))}
        </Select>
        <Select
          aria-label="Payment endpoint source"
          placeholder="Choose public or private endpoints"
          value={source}
          onChange={setSource}
          style={{ minWidth: 320 }}
        >
          <Select.Option value="public">Public</Select.Option>
          <Select.Option value="private">Private</Select.Option>
        </Select>
        {selected &&
          source &&
          !selected.endpointBindings.some(binding => binding.source === source) && (
            <Alert
              type="warning"
              message={`This request has no ${source} endpoint binding. Choose a source listed in its immutable receiving endpoints.`}
            />
          )}
        <Select
          aria-label="Payment method"
          placeholder={
            preference.length
              ? `Saved preference: ${preference.join(', ')}`
              : 'Choose a payment method'
          }
          allowClear
          value={method}
          onChange={setMethod}
          style={{ minWidth: 320 }}
        >
          {paykitMethods.map(item => (
            <Select.Option
              key={item}
              value={item}
              disabled={
                !selected?.acceptedMethods.includes(item) ||
                !wallet?.supportedMethods.includes(item) ||
                !selected?.endpointBindings.some(
                  binding => binding.source === source && binding.method === item,
                )
              }
            >
              {item}
            </Select.Option>
          ))}
        </Select>
        {hasExecution && (
          <Alert
            type="info"
            message="This request already has an execution. Inspect or reconcile that execution before taking further action."
          />
        )}
        <Button
          type="primary"
          disabled={
            disabled ||
            selected?.lifecycle !== 'accepted' ||
            !walletId ||
            !source ||
            !availableMethod ||
            hasExecution
          }
          onClick={() =>
            source &&
            command('payment.execute', {
              receiverId,
              requestId,
              walletId,
              source,
              ...(method ? { method } : {}),
            })
          }
        >
          Pay accepted request
        </Button>
        <List
          dataSource={executions.slice().reverse()}
          locale={{ emptyText: 'No payment executions' }}
          renderItem={item => (
            <List.Item>
              <div>
                <Descriptions size="small" column={1}>
                  <Descriptions.Item label="Execution">{item.id}</Descriptions.Item>
                  <Descriptions.Item label="Request">{item.requestId}</Descriptions.Item>
                  <Descriptions.Item label="Payment execution">
                    <Tag>{item.status}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="Amount">
                    {item.amountSats} sats
                  </Descriptions.Item>
                  <Descriptions.Item label="Wallet">{item.walletId}</Descriptions.Item>
                  <Descriptions.Item label="Endpoint source">
                    {item.source}
                  </Descriptions.Item>
                  <Descriptions.Item label="Method">{item.method}</Descriptions.Item>
                  <Descriptions.Item label="Endpoint">
                    <Typography.Text copyable style={{ overflowWrap: 'anywhere' }}>
                      {item.endpoint}
                    </Typography.Text>
                  </Descriptions.Item>
                  {item.txid && (
                    <Descriptions.Item label="Transaction output">
                      {item.txid}:{item.outputIndex}
                    </Descriptions.Item>
                  )}
                  {item.paymentHash && (
                    <Descriptions.Item label="Payment hash">
                      {item.paymentHash}
                    </Descriptions.Item>
                  )}
                </Descriptions>
                {item.lastError && <Alert type="error" message={item.lastError} />}
                <Button
                  disabled={disabled}
                  onClick={() =>
                    command('payment.reconcile', { receiverId, executionId: item.id })
                  }
                >
                  Reconcile execution
                </Button>
              </div>
            </List.Item>
          )}
        />
      </Space>
    </Card>
  );
};
export default PaykitRequests;
