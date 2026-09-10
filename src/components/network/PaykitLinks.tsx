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
  PaykitCommand,
  PaykitInput,
  PaykitReceiverWorkspace,
  PaykitState,
} from 'shared/paykitApi';

export interface PaykitReceiverPanelProps {
  receiverId: string;
  workspace?: PaykitReceiverWorkspace;
  disabled: boolean;
  command: (name: PaykitCommand, input: PaykitInput) => Promise<void>;
}
const states = ['notLinked', 'linking', 'linked', 'recoveryRequired', 'blocked'];
const PaykitLinks: React.FC<PaykitReceiverPanelProps & { state: PaykitState }> = ({
  receiverId,
  workspace,
  disabled,
  command,
  state,
}) => {
  const [peerPublicKey, setKey] = useState('');
  const [peerReceiverPath, setPath] = useState('');
  const receiver = state.receivers.find(item => item.id === receiverId);
  const input = {
    receiverId,
    peerPublicKey: peerPublicKey.trim(),
    peerReceiverPath: peerReceiverPath.trim(),
  };
  const peerDisabled = disabled || !peerPublicKey.trim() || !peerReceiverPath.trim();
  return (
    <Card title="Encrypted links" style={{ marginTop: 12 }}>
      <Typography.Paragraph>
        Choose a peer receiver explicitly. Initiate on one side, then accept on the other.
        Recovery or unblocking requires explicit relinking. Empty lists demonstrate
        encrypted delivery and contain no payment endpoints.
      </Typography.Paragraph>
      {workspace?.lastError && (
        <Alert type="error" message={workspace.lastError} showIcon />
      )}
      <Space wrap>
        <Tag color={workspace?.deliveryPaused ? 'orange' : 'green'}>
          {workspace?.deliveryPaused
            ? 'Private delivery paused'
            : 'Private delivery enabled'}
        </Tag>
        <Button
          disabled={disabled || !workspace}
          onClick={() =>
            command(workspace?.deliveryPaused ? 'delivery.resume' : 'delivery.pause', {
              receiverId,
            })
          }
        >
          {workspace?.deliveryPaused
            ? 'Resume private delivery'
            : 'Pause private delivery'}
        </Button>
        <Button
          disabled={disabled || !workspace || workspace.deliveryPaused}
          onClick={() => command('delivery.sync', { receiverId })}
        >
          Sync private delivery
        </Button>
      </Space>
      <p>Pausing retains links and queued messages. Sync never bypasses pause.</p>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select
          aria-label="Local peer receiver"
          placeholder="Choose a local peer receiver"
          style={{ minWidth: 300 }}
          value={undefined}
          onChange={(id: string) => {
            const peer = state.receivers.find(item => item.id === id)!;
            setKey(
              state.participants.find(item => item.id === peer.participantId)!.publicKey,
            );
            setPath(peer.path);
          }}
        >
          {state.receivers
            .filter(item => item.participantId !== receiver?.participantId)
            .map(item => (
              <Select.Option key={item.id} value={item.id}>
                {state.participants.find(p => p.id === item.participantId)?.name} /{' '}
                {item.name}
              </Select.Option>
            ))}
        </Select>
        <Input
          aria-label="Link peer public key"
          placeholder="Peer public key"
          value={peerPublicKey}
          onChange={e => setKey(e.target.value)}
        />
        <Input
          aria-label="Link peer receiver path"
          placeholder="Peer receiver path, e.g. app/wallet"
          value={peerReceiverPath}
          onChange={e => setPath(e.target.value)}
        />
        <Space wrap>
          {(
            [
              ['link.initiate', 'Initiate link'],
              ['link.accept', 'Accept link'],
              ['link.advance', 'Advance link'],
              ['link.block', 'Block peer'],
              ['link.unblock', 'Unblock peer'],
              ['link.sendEmptyList', 'Queue empty encrypted list'],
            ] as [PaykitCommand, string][]
          ).map(([name, label]) => (
            <Button
              key={name}
              disabled={peerDisabled}
              onClick={() => command(name, input)}
            >
              {label}
            </Button>
          ))}
        </Space>
      </Space>
      <List
        dataSource={workspace?.links || []}
        locale={{ emptyText: 'No links for this receiver' }}
        renderItem={link => (
          <List.Item>
            <div style={{ width: '100%' }}>
              <Typography.Text copyable>{link.peerPublicKey}</Typography.Text> /{' '}
              {link.peerReceiverPath}
              <Tag color={link.state === 'linked' ? 'green' : 'orange'}>{link.state}</Tag>
              {!states.includes(link.state) && (
                <Alert
                  type="error"
                  message={`Unsupported link state: ${link.state}. Update the application before continuing.`}
                />
              )}
              {link.state === 'recoveryRequired' && (
                <Alert
                  type="warning"
                  message="This link requires explicit relinking; automatic advancement is stopped."
                />
              )}
              {link.lastError && <Alert type="error" message={link.lastError} />}
              <Descriptions size="small" column={2}>
                <Descriptions.Item label="Generation">
                  {link.generation}
                </Descriptions.Item>
                <Descriptions.Item label="Handshake role">
                  {link.handshakeRole || 'None'}
                </Descriptions.Item>
                <Descriptions.Item label="Queued messages">
                  {link.pendingMessages}
                </Descriptions.Item>
                <Descriptions.Item label="Last published message">
                  {link.lastSentMessageId || 'Not observed'}
                </Descriptions.Item>
                <Descriptions.Item label="Last received list">
                  {link.latestReceivedListId || 'None'}
                </Descriptions.Item>
                <Descriptions.Item label="Failures">
                  {link.failureCount}
                </Descriptions.Item>
                <Descriptions.Item label="Last sync">
                  {link.lastSyncAt || 'Never'}
                </Descriptions.Item>
                <Descriptions.Item label="Last received">
                  {link.lastReceiveAt || 'Never'}
                </Descriptions.Item>
              </Descriptions>
              <Button
                onClick={() => {
                  setKey(link.peerPublicKey);
                  setPath(link.peerReceiverPath);
                }}
              >
                Select link
              </Button>
            </div>
          </List.Item>
        )}
      />
    </Card>
  );
};
export default PaykitLinks;
