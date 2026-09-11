import React, { useState } from 'react';
import { Alert, Button, Card, Descriptions, Input, Space, Tag, Typography } from 'antd';
import {
  newPaykitId,
  PaykitOperationResult,
  PaykitReceiver,
  PaykitReceiverWorkspace,
} from 'shared/paykitApi';
import { paykitService } from 'lib/paykit/paykitService';

const terminalOperation = async (networkId: number, operationId: string) => {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    const operation = await paykitService.operation(networkId, operationId);
    if (operation.status === 'succeeded') return operation.result || {};
    if (operation.status === 'failed')
      throw new Error(
        `${operation.error?.code || 'operation_failed'}: ${
          operation.error?.message || 'Backup operation failed'
        }`,
      );
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Operation ${operationId} timed out; retry with the same command ID`);
};

const PaykitBackupRecovery: React.FC<{
  networkId: number;
  receiver: PaykitReceiver;
  workspace?: PaykitReceiverWorkspace;
  disabled?: boolean;
  command: (name: any, input: any) => Promise<unknown> | void;
}> = ({ networkId, receiver, workspace, disabled, command }) => {
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<PaykitOperationResult>();
  const [restoreTransferId, setRestoreTransferId] = useState('');
  const stopped = receiver.status === 'stopped';
  const submit = async (
    name: 'backup.export' | 'backup.inspect' | 'backup.restore',
    transferId: string,
  ) => {
    const request = {
      commandId: newPaykitId(),
      command: name,
      input: { receiverId: receiver.id, transferId },
    } as const;
    const accepted = await paykitService.command(networkId, request);
    return terminalOperation(networkId, accepted.operationId);
  };
  const run = async (task: () => Promise<void>) => {
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
  const stage = async (purpose: 'export' | 'restore') => {
    const secret = passphrase;
    setPassphrase('');
    return purpose === 'export'
      ? paykitService.prepareExport(networkId, receiver.id, secret)
      : paykitService.prepareRestore(networkId, receiver.id, secret);
  };
  const exportBackup = () =>
    run(async () => {
      const transfer = await stage('export');
      try {
        await submit('backup.export', transfer.transferId);
        await paykitService.downloadExport(networkId, transfer.transferId);
      } catch (error) {
        await paykitService
          .cancelTransfer(networkId, transfer.transferId)
          .catch(() => undefined);
        throw error;
      }
    });
  const inspectBackup = () =>
    run(async () => {
      const transfer = await stage('restore');
      try {
        const result = await submit('backup.inspect', transfer.transferId);
        setPreview(result);
        setRestoreTransferId(transfer.transferId);
      } catch (error) {
        await paykitService
          .cancelTransfer(networkId, transfer.transferId)
          .catch(() => undefined);
        throw error;
      }
    });
  const restoreBackup = () =>
    run(async () => {
      const result = await submit('backup.restore', restoreTransferId);
      setPreview(result);
      setRestoreTransferId('');
    });
  const recovery = workspace?.recovery;
  return (
    <Card size="small" title="Backup & recovery">
      <Space direction="vertical" style={{ width: '100%' }}>
        <Typography.Text type="secondary">
          Encrypted backups preserve this receiver’s identity and local payment state.
          Inspection never changes live state.
        </Typography.Text>
        {error && <Alert type="error" showIcon message={error} />}
        {recovery?.automationPaused && (
          <Alert
            type="warning"
            showIcon
            message="Automation is paused until SDK validation, wallet reconciliation, and required relinking complete."
          />
        )}
        <Input.Password
          aria-label="Backup passphrase"
          value={passphrase}
          onChange={event => setPassphrase(event.target.value)}
          autoComplete="new-password"
          placeholder="Passphrase (12–1024 UTF-8 bytes)"
        />
        <Space wrap>
          {!stopped && (
            <Button
              disabled={disabled || busy}
              onClick={() => command('receiver.stop', { receiverId: receiver.id })}
            >
              Stop receiver
            </Button>
          )}
          <Button
            disabled={disabled || busy || !stopped || passphrase.length < 12}
            loading={busy}
            onClick={exportBackup}
          >
            Export encrypted backup
          </Button>
          <Button
            disabled={disabled || busy || !stopped || passphrase.length < 12}
            loading={busy}
            onClick={inspectBackup}
          >
            Open and inspect backup
          </Button>
          <Button
            type="primary"
            danger
            disabled={
              disabled ||
              busy ||
              !stopped ||
              !restoreTransferId ||
              preview?.restorable !== true
            }
            onClick={restoreBackup}
          >
            Restore inspected backup
          </Button>
          <Button
            disabled={disabled || busy || !recovery || recovery.walletReconciled}
            onClick={() => command('recovery.reconcile', { receiverId: receiver.id })}
          >
            Reconcile wallets
          </Button>
        </Space>
        {preview && (
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Restorable">
              <Tag color={preview.restorable ? 'green' : 'red'}>
                {preview.restorable ? 'yes' : 'no'}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Created">
              {preview.createdAt || 'unknown'}
            </Descriptions.Item>
            <Descriptions.Item label="Identity match">
              {preview.identityMatches ? 'yes' : 'no'}
            </Descriptions.Item>
            <Descriptions.Item label="Receiver match">
              {preview.receiverMatches ? 'yes' : 'no'}
            </Descriptions.Item>
            <Descriptions.Item label="SDK validation">
              {preview.sdkValidationPending ? 'pending until restore' : 'complete'}
            </Descriptions.Item>
            <Descriptions.Item label="Unknown wallet activity">
              {preview.wallet?.unknownAfterExport ?? 0}
            </Descriptions.Item>
            <Descriptions.Item label="Blocked reasons">
              {preview.blockedReasons?.join(', ') || 'none'}
            </Descriptions.Item>
          </Descriptions>
        )}
        {recovery && (
          <Descriptions size="small" column={2} bordered>
            <Descriptions.Item label="Recovery phase">{recovery.phase}</Descriptions.Item>
            <Descriptions.Item label="SDK validated">
              {recovery.sdkValidated ? 'yes' : 'no'}
            </Descriptions.Item>
            <Descriptions.Item label="Wallet reconciled">
              {recovery.walletReconciled ? 'yes' : 'no'}
            </Descriptions.Item>
            <Descriptions.Item label="Unknown wallet activity">
              {recovery.unknownAfterExportCount}
            </Descriptions.Item>
          </Descriptions>
        )}
        {recovery?.peersRequiringRelink.map(peer => (
          <Space
            direction="vertical"
            key={`${peer.peerPublicKey}:${peer.peerReceiverPath}`}
          >
            <Typography.Text type="secondary">
              Select this counterparty to prepare recovery, then return to the original
              side and prepare again before starting a fresh handshake.
            </Typography.Text>
            <Button
              disabled={disabled || busy}
              onClick={() =>
                command('link.prepareRecovery', { receiverId: receiver.id, ...peer })
              }
            >
              Prepare recovery with {peer.peerReceiverPath}
            </Button>
          </Space>
        ))}
      </Space>
    </Card>
  );
};
export default PaykitBackupRecovery;
