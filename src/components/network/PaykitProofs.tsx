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
import { PaykitMethod, PaykitProofMaterial, paykitMethods } from 'shared/paykitApi';
import { PaykitReceiverPanelProps } from './PaykitLinks';

const PaykitProofs: React.FC<PaykitReceiverPanelProps> = ({
  receiverId,
  workspace,
  disabled,
  command,
}) => {
  const [requestId, setRequest] = useState('');
  const [mode, setMode] = useState<'prepared' | 'manual'>('prepared');
  const [executionId, setExecution] = useState('');
  const [method, setMethod] = useState<PaykitMethod>('btc-onchain');
  const [txid, setTxid] = useState('');
  const [outputIndex, setOutput] = useState('0');
  const [paymentHash, setHash] = useState('');
  const [preimage, setPreimage] = useState('');
  const [confirmations, setConfirmations] = useState('1');
  const requests = workspace?.requests || [];
  const proof: PaykitProofMaterial =
    method === 'btc-onchain'
      ? { method, txid: txid.trim(), outputIndex: Number(outputIndex) }
      : { method, paymentHash: paymentHash.trim(), preimage: preimage.trim() };
  return (
    <Card title="Proofs and settlement" style={{ marginTop: 12 }}>
      <Typography.Paragraph>
        Submit a prepared proof from a successful execution, or enter a proof to validate.
        The payee verifies settlement independently against its wallet and chain. A
        delivered proof alone does not confirm payment.
      </Typography.Paragraph>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Select
          aria-label="Proof request"
          placeholder="Select request"
          value={requestId || undefined}
          onChange={id => {
            setRequest(id);
            setExecution('');
          }}
          style={{ minWidth: 320 }}
        >
          {requests
            .filter(item => item.role === 'payer')
            .map(item => (
              <Select.Option key={item.id} value={item.id}>
                {item.description} · {item.amountSats} sats
              </Select.Option>
            ))}
        </Select>
        <Select
          aria-label="Proof source"
          value={mode}
          onChange={setMode}
          style={{ minWidth: 320 }}
        >
          <Select.Option value="prepared">Prepared execution proof</Select.Option>
          <Select.Option value="manual">Enter proof manually</Select.Option>
        </Select>
        {mode === 'prepared' ? (
          <Select
            aria-label="Proof execution"
            placeholder="Select successful execution"
            value={executionId || undefined}
            onChange={setExecution}
            style={{ minWidth: 320 }}
          >
            {workspace?.executions
              ?.filter(
                item => item.requestId === requestId && item.status === 'succeeded',
              )
              .map(item => (
                <Select.Option key={item.id} value={item.id}>
                  {item.id} · {item.method}
                </Select.Option>
              ))}
          </Select>
        ) : (
          <>
            <Select
              aria-label="Proof method"
              value={method}
              onChange={setMethod}
              style={{ minWidth: 320 }}
            >
              {paykitMethods.map(item => (
                <Select.Option key={item} value={item}>
                  {item}
                </Select.Option>
              ))}
            </Select>
            {method === 'btc-onchain' ? (
              <>
                <Input
                  aria-label="Proof transaction ID"
                  placeholder="Transaction ID (64 hexadecimal characters)"
                  value={txid}
                  onChange={e => setTxid(e.target.value)}
                />
                <Input
                  aria-label="Proof output index"
                  addonAfter="output index"
                  value={outputIndex}
                  onChange={e => setOutput(e.target.value)}
                />
              </>
            ) : (
              <>
                <Input
                  aria-label="Proof payment hash"
                  placeholder="Payment hash (64 hexadecimal characters)"
                  value={paymentHash}
                  onChange={e => setHash(e.target.value)}
                />
                <Input
                  aria-label="Proof preimage"
                  placeholder="Payment proof preimage (64 hexadecimal characters)"
                  value={preimage}
                  onChange={e => setPreimage(e.target.value)}
                />
              </>
            )}
          </>
        )}
        <Button
          disabled={disabled || !requestId || (mode === 'prepared' && !executionId)}
          onClick={() =>
            command('proof.submit', {
              receiverId,
              requestId,
              ...(mode === 'prepared' ? { executionId } : { proof }),
            })
          }
        >
          Submit payment proof
        </Button>
        <Input
          aria-label="Required settlement confirmations"
          addonAfter="required on-chain confirmations (1–144)"
          value={confirmations}
          onChange={e => setConfirmations(e.target.value)}
        />
        <List
          dataSource={workspace?.proofs?.slice().reverse() || []}
          locale={{ emptyText: 'No payment proofs' }}
          renderItem={item => {
            const settlement = workspace?.settlements?.find(
              value => value.proofId === item.id,
            );
            const request = requests.find(value => value.id === item.requestId);
            return (
              <List.Item>
                <div>
                  <Descriptions size="small" column={1}>
                    <Descriptions.Item label="Proof">{item.id}</Descriptions.Item>
                    <Descriptions.Item label="Request">
                      {item.requestId}
                    </Descriptions.Item>
                    <Descriptions.Item label="Proof delivery">
                      <Tag>{item.deliveryStatus}</Tag>
                    </Descriptions.Item>
                    <Descriptions.Item label="Settlement verification">
                      <Tag>{settlement?.status || 'Not verified'}</Tag>
                    </Descriptions.Item>
                    {settlement && (
                      <Descriptions.Item label="Confirmations">
                        {settlement.confirmations} / {settlement.requiredConfirmations}
                      </Descriptions.Item>
                    )}
                  </Descriptions>
                  <pre
                    aria-label="Payment proof material"
                    style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                  >
                    {JSON.stringify(item.proof, null, 2)}
                  </pre>
                  {!item.proof && (
                    <Alert
                      type="error"
                      message="Malformed proof material was rejected by the application boundary."
                    />
                  )}
                  {settlement?.lastError && (
                    <Alert
                      type={settlement.status === 'pending' ? 'info' : 'error'}
                      message={settlement.lastError}
                    />
                  )}
                  <Button
                    disabled={disabled || request?.role !== 'payee'}
                    onClick={() =>
                      command('proof.verify', {
                        receiverId,
                        requestId: item.requestId,
                        proofId: item.id,
                        requiredConfirmations: Number(confirmations),
                      })
                    }
                  >
                    Verify settlement
                  </Button>
                </div>
              </List.Item>
            );
          }}
        />
      </Space>
    </Card>
  );
};
export default PaykitProofs;
