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
  Tag,
  Typography,
} from 'antd';
import { PaykitMethod, paykitMethods, PaykitState } from 'shared/paykitApi';
import { PaykitReceiverPanelProps } from './PaykitLinks';

const methodLabels: Record<PaykitMethod, string> = {
  'btc-onchain': 'Bitcoin on-chain',
  'btc-lightning-bolt11': 'Lightning BOLT11',
};
const PaykitPaymentMethods: React.FC<
  PaykitReceiverPanelProps & { state: PaykitState }
> = ({ receiverId, workspace, disabled, command, state }) => {
  const configured = workspace?.paymentMethods;
  const [walletId, setWallet] = useState(configured?.walletId || '');
  const [enabledMethods, setMethods] = useState<string[]>(
    configured?.enabledMethods || [],
  );
  const [preference, setPreference] = useState<string[]>(configured?.preference || []);
  const [amountSats, setAmount] = useState('1000');
  const [expiry, setExpiry] = useState('3600');
  const [peerPublicKey, setPeerKey] = useState('');
  const [peerReceiverPath, setPeerPath] = useState('');
  const [source, setSource] = useState<'public' | 'private'>();
  const [method, setMethod] = useState<string>();
  const savedMethods = configured?.enabledMethods.join(',');
  const savedPreference = configured?.preference.join(',');
  useEffect(() => {
    setWallet(configured?.walletId || '');
    setMethods(savedMethods?.split(',').filter(Boolean) || []);
    setPreference(savedPreference?.split(',').filter(Boolean) || []);
  }, [receiverId, configured?.walletId, savedMethods, savedPreference]);
  const receiver = state.receivers.find(item => item.id === receiverId);
  const wallet = configured?.wallets.find(item => item.id === walletId);
  const peer = {
    receiverId,
    peerPublicKey: peerPublicKey.trim(),
    peerReceiverPath: peerReceiverPath.trim(),
  };
  const terms = { amountSats, expirySeconds: Number(expiry) };
  const noPeer = disabled || !peer.peerPublicKey || !peer.peerReceiverPath;
  const publicList = workspace?.publicPaymentList;
  return (
    <Card title="Payment methods and reservations" style={{ marginTop: 12 }}>
      <Typography.Paragraph>
        Configure receiving wallets, publish endpoints and reserve private lists. Satoshi
        amounts are exact integers. Creating or consuming a list does not send a payment.
      </Typography.Paragraph>
      <Space direction="vertical" style={{ width: '100%' }}>
        {!configured?.wallets.length && (
          <Alert
            type="info"
            message="No receiving wallets configured. Add a Bitcoin Core node or an LND node with a Core backend, then restart the network."
          />
        )}
        <Select
          aria-label="Receiving wallet"
          placeholder="Select receiving wallet"
          value={walletId || undefined}
          onChange={setWallet}
          style={{ minWidth: 320 }}
        >
          {configured?.wallets.map(item => (
            <Select.Option key={item.id} value={item.id}>
              {item.label} ({item.status})
            </Select.Option>
          ))}
        </Select>
        <Typography.Text type="secondary">
          Wallet configuration does not guarantee availability. Wallet failures appear in
          operations and reservation history.
        </Typography.Text>
        <Select
          mode="multiple"
          aria-label="Enabled receiving methods"
          placeholder="Enabled receiving methods"
          value={enabledMethods}
          onChange={setMethods}
          style={{ minWidth: 320 }}
        >
          {paykitMethods.map(item => (
            <Select.Option
              key={item}
              value={item}
              disabled={!wallet?.supportedMethods.includes(item)}
            >
              {methodLabels[item]}
            </Select.Option>
          ))}
        </Select>
        <Select
          mode="multiple"
          aria-label="Method preference order"
          placeholder="Select methods in preference order"
          value={preference}
          onChange={setPreference}
          style={{ minWidth: 320 }}
        >
          {paykitMethods.map(item => (
            <Select.Option
              key={item}
              value={item}
              disabled={!enabledMethods.includes(item)}
            >
              {methodLabels[item]}
            </Select.Option>
          ))}
        </Select>
        <Typography.Text>
          Preference order:{' '}
          {preference.join(' → ') || 'None — select a method explicitly when resolving'}
        </Typography.Text>
        <Space wrap>
          <Button
            disabled={disabled || !walletId || !enabledMethods.length}
            onClick={() =>
              command('method.configure', {
                receiverId,
                walletId,
                enabledMethods,
                preference,
              })
            }
          >
            Save receiving configuration
          </Button>
          <Button
            disabled={disabled || !configured?.walletId}
            onClick={() => command('method.prefer', { receiverId, preference })}
          >
            Save method preference
          </Button>
        </Space>
        <Input
          aria-label="Payment amount in satoshis"
          addonBefore="Amount (sats)"
          inputMode="numeric"
          value={amountSats}
          onChange={event => setAmount(event.target.value)}
        />
        <Input
          aria-label="Endpoint expiry in seconds"
          addonBefore="Expiry (seconds)"
          inputMode="numeric"
          value={expiry}
          onChange={event => setExpiry(event.target.value)}
        />
        <Space wrap>
          <Button
            disabled={disabled || !configured?.walletId}
            onClick={() => command('paymentList.publish', { receiverId, ...terms })}
          >
            Publish public payment list
          </Button>
          <Button
            disabled={disabled || !publicList}
            onClick={() => command('paymentList.unpublish', { receiverId })}
          >
            Withdraw public payment list
          </Button>
        </Space>
        {publicList && (
          <Descriptions size="small" column={2} title="Public payment list">
            <Descriptions.Item label="List ID">{publicList.id}</Descriptions.Item>
            <Descriptions.Item label="Lifecycle">{publicList.status}</Descriptions.Item>
            <Descriptions.Item label="Amount">
              {publicList.amountSats} sats
            </Descriptions.Item>
            <Descriptions.Item label="Expires">{publicList.expiresAt}</Descriptions.Item>
            <Descriptions.Item label="Delivery">
              {publicList.deliveryStatus}
            </Descriptions.Item>
            <Descriptions.Item label="Cleanup">
              {publicList.cleanupStatus}
            </Descriptions.Item>
            {publicList.lastError && (
              <Descriptions.Item label="Error">{publicList.lastError}</Descriptions.Item>
            )}
          </Descriptions>
        )}
        <Typography.Title level={5}>
          Private reservations and endpoint discovery
        </Typography.Title>
        <Select
          aria-label="Payment peer receiver"
          placeholder="Choose a local peer receiver"
          value={undefined}
          style={{ minWidth: 320 }}
          onChange={(id: string) => {
            const other = state.receivers.find(item => item.id === id);
            const owner = state.participants.find(
              item => item.id === other?.participantId,
            );
            if (other && owner) {
              setPeerKey(owner.publicKey);
              setPeerPath(other.path);
            }
          }}
        >
          {state.receivers
            .filter(item => item.participantId !== receiver?.participantId)
            .map(item => (
              <Select.Option key={item.id} value={item.id}>
                {state.participants.find(owner => owner.id === item.participantId)?.name}{' '}
                / {item.name}
              </Select.Option>
            ))}
        </Select>
        <Input
          aria-label="Payment peer public key"
          placeholder="Peer public key"
          value={peerPublicKey}
          onChange={event => setPeerKey(event.target.value)}
        />
        <Input
          aria-label="Payment peer receiver path"
          placeholder="Peer receiver path, e.g. app/wallet"
          value={peerReceiverPath}
          onChange={event => setPeerPath(event.target.value)}
        />
        <Space wrap>
          <Button
            disabled={noPeer || !configured?.walletId}
            onClick={() => command('reservation.create', { ...peer, ...terms })}
          >
            Create private reservation
          </Button>
          <Button
            disabled={noPeer || !configured?.walletId}
            onClick={() => command('reservation.rotate', { ...peer, ...terms })}
          >
            Rotate private reservation
          </Button>
        </Space>
        <Typography.Paragraph>
          Private delivery requires an established encrypted link. Rotation supersedes the
          previous list. Withdrawals and cleanup can remain pending while services or
          peers are offline. Revealed Bitcoin addresses remain assigned permanently.
        </Typography.Paragraph>
        <Space wrap>
          <Select
            aria-label="Payment list source"
            placeholder="Choose public or private"
            value={source}
            onChange={setSource}
            style={{ minWidth: 230 }}
          >
            <Select.Option value="public">Public</Select.Option>
            <Select.Option value="private">Private encrypted list</Select.Option>
          </Select>
          <Select
            aria-label="Resolution method"
            placeholder="Use saved preference"
            allowClear
            value={method}
            onChange={setMethod}
            style={{ minWidth: 230 }}
          >
            {paykitMethods.map(item => (
              <Select.Option key={item} value={item}>
                {methodLabels[item]}
              </Select.Option>
            ))}
          </Select>
          <Button
            disabled={noPeer || !source || (!method && !configured?.preference.length)}
            onClick={() =>
              source &&
              command('paymentList.resolve', {
                ...peer,
                source,
                amountSats,
                ...(method ? { method } : {}),
              })
            }
          >
            Resolve selected payment list
          </Button>
        </Space>
        <Typography.Text type="secondary">
          Choose a source explicitly. Private discovery never falls back to public. An
          explicit method overrides the saved preference; unavailable methods remain
          visible.
        </Typography.Text>
      </Space>
      <Typography.Title level={5}>Reservation history</Typography.Title>
      <List
        dataSource={workspace?.reservations?.slice().reverse() || []}
        locale={{ emptyText: 'No reservations for this receiver' }}
        renderItem={reservation => {
          const eligible =
            reservation.status === 'active' &&
            Date.parse(reservation.expiresAt) > Date.now();
          return (
            <List.Item>
              <div style={{ width: '100%', overflowWrap: 'anywhere' }}>
                <Typography.Text strong>
                  {reservation.method} · {reservation.amountSats} sats ·{' '}
                  {reservation.source}
                </Typography.Text>
                <Descriptions size="small" column={2}>
                  <Descriptions.Item label="Reservation ID">
                    {reservation.id}
                  </Descriptions.Item>
                  <Descriptions.Item label="List ID">
                    {reservation.listId}
                  </Descriptions.Item>
                  <Descriptions.Item label="Wallet">
                    {reservation.walletId}
                  </Descriptions.Item>
                  <Descriptions.Item label="Lifecycle">
                    {reservation.status}
                  </Descriptions.Item>
                  <Descriptions.Item label="Eligibility">
                    <Tag color={eligible ? 'green' : 'orange'}>
                      {eligible ? 'Eligible' : 'Ineligible'}
                    </Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="Expires">
                    {reservation.expiresAt}
                  </Descriptions.Item>
                  <Descriptions.Item label="Delivery">
                    {reservation.deliveryStatus}
                  </Descriptions.Item>
                  <Descriptions.Item label="Cleanup">
                    {reservation.cleanupStatus}
                  </Descriptions.Item>
                  <Descriptions.Item label="Peer">
                    {reservation.peerPublicKey || 'Public'} /{' '}
                    {reservation.peerReceiverPath || 'Public'}
                  </Descriptions.Item>
                  <Descriptions.Item label="Published message">
                    {reservation.outboundMessageId || 'Not observed'}
                  </Descriptions.Item>
                </Descriptions>
                {reservation.endpoint && (
                  <Typography.Paragraph copyable>
                    {reservation.endpoint}
                  </Typography.Paragraph>
                )}
                {reservation.lastError && (
                  <Alert type="error" message={reservation.lastError} />
                )}
                <Space wrap>
                  <Button
                    disabled={
                      disabled ||
                      ['cancelled', 'expired', 'superseded'].includes(reservation.status)
                    }
                    onClick={() =>
                      command('reservation.cancel', {
                        receiverId,
                        reservationId: reservation.id,
                      })
                    }
                  >
                    Cancel reservation
                  </Button>
                  <Button
                    disabled={disabled}
                    onClick={() =>
                      command('reservation.reconcile', {
                        receiverId,
                        reservationId: reservation.id,
                      })
                    }
                  >
                    Reconcile reservation
                  </Button>
                </Space>
              </div>
            </List.Item>
          );
        }}
      />
      <Typography.Title level={5}>Resolved endpoints</Typography.Title>
      <List
        dataSource={workspace?.resolutions?.slice().reverse() || []}
        locale={{ emptyText: 'No endpoint resolutions' }}
        renderItem={resolution => (
          <List.Item>
            <div style={{ width: '100%', overflowWrap: 'anywhere' }}>
              <Tag>{resolution.status}</Tag>
              {resolution.source} · {resolution.method || 'No selected method'} ·{' '}
              {resolution.amountSats} sats
              <Descriptions size="small" column={1}>
                <Descriptions.Item label="Resolution ID">
                  {resolution.id}
                </Descriptions.Item>
                <Descriptions.Item label="Peer">
                  {resolution.peerPublicKey} / {resolution.peerReceiverPath}
                </Descriptions.Item>
                <Descriptions.Item label="Private list version">
                  {resolution.version || 'Not applicable'}
                </Descriptions.Item>
                <Descriptions.Item label="Expires">
                  {resolution.expiresAt || 'Not provided'}
                </Descriptions.Item>
              </Descriptions>
              {resolution.endpoint && (
                <Typography.Paragraph copyable>
                  {resolution.endpoint}
                </Typography.Paragraph>
              )}
              {resolution.lastError && (
                <Alert type="error" message={resolution.lastError} />
              )}
              {resolution.source === 'private' && (
                <Button
                  disabled={
                    disabled ||
                    resolution.status !== 'payable' ||
                    (!!resolution.expiresAt &&
                      Date.parse(resolution.expiresAt) <= Date.now())
                  }
                  onClick={() =>
                    command('paymentList.consume', {
                      receiverId,
                      resolutionId: resolution.id,
                    })
                  }
                >
                  Consume private list without payment
                </Button>
              )}
            </div>
          </List.Item>
        )}
      />
    </Card>
  );
};
export default PaykitPaymentMethods;
