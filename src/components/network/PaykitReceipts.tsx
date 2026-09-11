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
import { paykitMethods } from 'shared/paykitApi';
import { PaykitReceiverPanelProps } from './PaykitLinks';

const PaykitReceipts: React.FC<PaykitReceiverPanelProps> = ({
  receiverId,
  workspace,
  disabled,
  command,
}) => {
  const [proofId, setProofId] = useState('');
  const [note, setNote] = useState('');
  const eligible = (workspace?.settlements || []).flatMap(settlement => {
    const request = workspace?.requests?.find(item => item.id === settlement.requestId);
    const proof = workspace?.proofs?.find(
      item => item.id === settlement.proofId && item.requestId === settlement.requestId,
    );
    return request?.role === 'payee' &&
      settlement.status === 'verified' &&
      settlement.verifiedAt &&
      proof?.proof &&
      paykitMethods.includes(proof.proof.method) &&
      request.acceptedMethods.includes(proof.proof.method)
      ? [{ request, proof }]
      : [];
  });
  const selected = eligible.find(item => item.proof.id === proofId);
  const prepared = workspace?.receiptIssuances?.find(
    item => item.proofId === proofId && item.requestId === selected?.request.id,
  );
  const noteValid =
    Buffer.byteLength(note, 'utf8') <= 500 && !/[\u0000-\u001f\u007f-\u009f]/.test(note);
  return (
    <Card title="Receipts and access" style={{ marginTop: 12 }}>
      <Typography.Paragraph>
        Prepare a receipt only after the payee independently verifies settlement.
        Preparation saves an immutable draft locally. Processing stores the encrypted
        receipt and queues private access. Access sent does not mean the payer has
        retrieved it.
      </Typography.Paragraph>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select
          aria-label="Receipt verified proof"
          placeholder="Select a verified request and proof"
          value={proofId || undefined}
          onChange={id => {
            setProofId(id);
            setNote('');
          }}
          style={{ minWidth: 320 }}
        >
          {eligible.map(({ request, proof }) => (
            <Select.Option key={proof.id} value={proof.id}>
              {request.description} · {request.amountSats} sats · {proof.method} ·{' '}
              {proof.id}
              {proof.billingPeriod &&
                ` · ${proof.billingPeriod.startsAt} → ${proof.billingPeriod.endsAt}`}
            </Select.Option>
          ))}
        </Select>
        {selected && (
          <Descriptions size="small" column={1}>
            <Descriptions.Item label="Receipt request">
              {selected.request.id}
            </Descriptions.Item>
            {selected.proof.billingPeriod && (
              <Descriptions.Item label="Billing period">
                {selected.proof.billingPeriod.startsAt} →{' '}
                {selected.proof.billingPeriod.endsAt}
              </Descriptions.Item>
            )}
            <Descriptions.Item label="Receipt recipient">
              {selected.request.peerPublicKey} / {selected.request.peerReceiverPath}
            </Descriptions.Item>
            <Descriptions.Item label="Payment reference">
              {selected.request.paymentReference}
            </Descriptions.Item>
          </Descriptions>
        )}
        <Input
          aria-label="Receipt note"
          placeholder="Optional note (maximum 500 UTF-8 bytes, no control characters)"
          maxLength={500}
          value={prepared?.note ?? note}
          disabled={disabled || !!prepared}
          onChange={e => setNote(e.target.value)}
        />
        {!prepared && !noteValid && (
          <Alert
            type="error"
            message="Receipt note must be at most 500 UTF-8 bytes without control characters."
          />
        )}
        {prepared && (
          <Alert
            type="info"
            message="This proof already has an immutable prepared receipt. Use its Process / resume action below."
          />
        )}
        <Button
          disabled={disabled || !selected || !!prepared || !noteValid}
          onClick={() =>
            selected &&
            command('receipt.prepare', {
              receiverId,
              requestId: selected.request.id,
              proofId: selected.proof.id,
              note,
            })
          }
        >
          Prepare receipt
        </Button>
        <Typography.Title level={5}>Issued receipt history</Typography.Title>
        <List
          dataSource={workspace?.receiptIssuances || []}
          rowKey="id"
          locale={{ emptyText: 'No prepared receipts' }}
          renderItem={item => (
            <List.Item>
              <div style={{ width: '100%' }}>
                <Descriptions size="small" column={1}>
                  {item.billingPeriod && (
                    <Descriptions.Item label="Billing period">
                      {item.billingPeriod.startsAt} → {item.billingPeriod.endsAt}
                    </Descriptions.Item>
                  )}
                  <Descriptions.Item label="Receipt ID">{item.id}</Descriptions.Item>
                  <Descriptions.Item label="Request / proof">
                    {item.requestId} / {item.proofId}
                  </Descriptions.Item>
                  <Descriptions.Item label="Recipient">
                    {item.peerPublicKey} / {item.peerReceiverPath}
                  </Descriptions.Item>
                  <Descriptions.Item label="Amount / method">
                    {item.amountSats} sats / {item.method}
                  </Descriptions.Item>
                  <Descriptions.Item label="Description">
                    {item.description}
                  </Descriptions.Item>
                  <Descriptions.Item label="Note">
                    {item.note || 'No note'}
                  </Descriptions.Item>
                  <Descriptions.Item label="Payment reference">
                    {item.paymentReference}
                  </Descriptions.Item>
                  <Descriptions.Item label="Receipt issuance">
                    <Tag>{item.status}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="Access delivery">
                    <Tag>{item.deliveryStatus}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="Access event / outbound message">
                    {item.accessEventId} / {item.outboundMessageId ?? 'Not queued'}
                  </Descriptions.Item>
                  <Descriptions.Item label="Prepared / updated">
                    {item.createdAt} / {item.updatedAt}
                  </Descriptions.Item>
                  <Descriptions.Item label="Stored / access queued">
                    {item.storedAt ?? 'Not stored'} /{' '}
                    {item.accessQueuedAt ?? 'Not queued'}
                  </Descriptions.Item>
                </Descriptions>
                {item.lastError && <Alert type="error" message={item.lastError} />}
                {item.status !== 'accessQueued' && (
                  <Button
                    aria-label={`Process receipt ${item.id}`}
                    disabled={disabled}
                    onClick={() =>
                      command('receipt.process', { receiverId, receiptId: item.id })
                    }
                  >
                    Process / resume receipt
                  </Button>
                )}
              </div>
            </List.Item>
          )}
        />
        <Typography.Paragraph>
          A failed operation can be retried using the original receipt below. Delivery
          continues through the encrypted link queue; use the link delivery controls to
          resume paused delivery or recover a link.
        </Typography.Paragraph>
        <Typography.Title level={5}>Received access</Typography.Title>
        <List
          dataSource={workspace?.receiptAccess || []}
          rowKey={item =>
            JSON.stringify([
              item.peerPublicKey,
              item.peerReceiverPath,
              item.receiptId,
              item.accessEventId,
            ])
          }
          locale={{ emptyText: 'No receipt access received' }}
          renderItem={item => (
            <List.Item>
              <div style={{ width: '100%' }}>
                <Descriptions size="small" column={1}>
                  {item.billingPeriod && (
                    <Descriptions.Item label="Billing period">
                      {item.billingPeriod.startsAt} → {item.billingPeriod.endsAt}
                    </Descriptions.Item>
                  )}
                  <Descriptions.Item label="Receipt ID">
                    {item.receiptId}
                  </Descriptions.Item>
                  <Descriptions.Item label="Issuer">
                    {item.peerPublicKey} / {item.peerReceiverPath}
                  </Descriptions.Item>
                  <Descriptions.Item label="Request">
                    {item.requestId ?? 'Not supplied'}
                  </Descriptions.Item>
                  <Descriptions.Item label="Payment reference">
                    {item.paymentReference}
                  </Descriptions.Item>
                  <Descriptions.Item label="Access event">
                    {item.accessEventId}
                  </Descriptions.Item>
                  <Descriptions.Item label="Retrieval">
                    <Tag>{item.retrievalStatus}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="Access received">
                    {item.receivedAt}
                  </Descriptions.Item>
                  <Descriptions.Item label="Last attempt / retrieved">
                    {item.attemptedAt ?? 'Not attempted'} /{' '}
                    {item.retrievedAt ?? 'Not retrieved'}
                  </Descriptions.Item>
                </Descriptions>
                {item.lastError && <Alert type="error" message={item.lastError} />}
                <Button
                  aria-label={`Retrieve receipt ${item.receiptId} from ${item.peerPublicKey} / ${item.peerReceiverPath}`}
                  disabled={disabled}
                  onClick={() =>
                    command('receipt.retrieve', {
                      receiverId,
                      receiptId: item.receiptId,
                      peerPublicKey: item.peerPublicKey,
                      peerReceiverPath: item.peerReceiverPath,
                    })
                  }
                >
                  {item.retrievalStatus === 'failed' ||
                  item.retrievalStatus === 'notFound'
                    ? 'Retry retrieval and decryption'
                    : 'Retrieve and decrypt receipt'}
                </Button>
              </div>
            </List.Item>
          )}
        />
        <Typography.Title level={5}>Decrypted receipt history</Typography.Title>
        <Typography.Paragraph>
          Decryption reveals receipt contents. It does not independently verify
          settlement; settlement checks remain in Proofs and settlement. Foreign receipts
          may omit fields.
        </Typography.Paragraph>
        <List
          dataSource={workspace?.receipts || []}
          rowKey={item =>
            JSON.stringify([item.issuerPublicKey, item.issuerReceiverPath, item.id])
          }
          locale={{ emptyText: 'No decrypted receipts' }}
          renderItem={item => (
            <List.Item>
              <Descriptions size="small" column={1}>
                {item.billingPeriod && (
                  <Descriptions.Item label="Billing period">
                    {item.billingPeriod.startsAt} → {item.billingPeriod.endsAt}
                  </Descriptions.Item>
                )}
                <Descriptions.Item label="Receipt ID">{item.id}</Descriptions.Item>
                <Descriptions.Item label="Issuer">
                  {item.issuerPublicKey} / {item.issuerReceiverPath}
                </Descriptions.Item>
                <Descriptions.Item label="Recipient">
                  {item.recipientPublicKey}
                </Descriptions.Item>
                <Descriptions.Item label="Request / proof">
                  {item.requestId ?? 'Not supplied'} / {item.proofId ?? 'Not supplied'}
                </Descriptions.Item>
                <Descriptions.Item label="Payment reference">
                  {item.paymentReference}
                </Descriptions.Item>
                <Descriptions.Item label="Amount">
                  {item.amountSats === null
                    ? 'Not supplied or unsupported'
                    : `${item.amountSats} sats`}
                </Descriptions.Item>
                <Descriptions.Item label="Method">
                  {item.method ?? 'Not supplied or unsupported'}
                </Descriptions.Item>
                <Descriptions.Item label="Description">
                  {item.description ?? 'Not supplied'}
                </Descriptions.Item>
                <Descriptions.Item label="Note">
                  {item.note ?? 'Not supplied'}
                </Descriptions.Item>
                <Descriptions.Item label="Access event">
                  {item.accessEventId}
                </Descriptions.Item>
                <Descriptions.Item label="Retrieved">
                  {item.retrievedAt}
                </Descriptions.Item>
              </Descriptions>
            </List.Item>
          )}
        />
      </Space>
    </Card>
  );
};
export default PaykitReceipts;
