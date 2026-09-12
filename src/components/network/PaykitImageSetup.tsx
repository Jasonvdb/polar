import React, { useEffect, useState } from 'react';
import { Alert, Button, Progress, Space, Typography } from 'antd';
import { PaykitImageSetupState } from 'shared/paykitRuntime';
import { paykitService } from 'lib/paykit/paykitService';

interface Props {
  onReady?: () => Promise<void>;
  disabled?: boolean;
}

const PaykitImageSetup: React.FC<Props> = ({ onReady, disabled }) => {
  const [setup, setSetup] = useState<PaykitImageSetupState>();
  const [enabling, setEnabling] = useState(false);
  const [enableError, setEnableError] = useState('');

  useEffect(() => {
    let disposed = false;
    const check = async () => {
      try {
        const next = await paykitService.imageStatus();
        if (!disposed) setSetup(next);
      } catch (error: any) {
        if (!disposed)
          setSetup({
            status: 'failed',
            message: error.message,
            recentOutput: [],
            error: { code: 'docker-unavailable', message: error.message },
          });
      }
    };
    check();
    return () => {
      disposed = true;
    };
  }, []);
  useEffect(() => {
    if (!setup || !['checking', 'building'].includes(setup.status)) return;
    const timer = setTimeout(async () => {
      try {
        setSetup(await paykitService.imageStatus());
      } catch (error: any) {
        setSetup({
          status: 'failed',
          message: error.message,
          recentOutput: [],
          error: { code: 'docker-unavailable', message: error.message },
        });
      }
    }, 750);
    return () => clearTimeout(timer);
  }, [setup]);

  const build = async () => {
    setEnableError('');
    const next = await paykitService.buildImage();
    setSetup(next);
  };
  const cancel = async () => {
    if (setup?.jobId) setSetup(await paykitService.cancelImageBuild(setup.jobId));
  };
  const enable = async () => {
    if (!onReady) return;
    setEnabling(true);
    setEnableError('');
    try {
      await onReady();
    } catch (error: any) {
      setEnableError(error.message);
    } finally {
      setEnabling(false);
    }
  };

  if (!setup || setup.status === 'checking')
    return (
      <Typography.Text>
        Checking Docker Desktop and the Paykit service image…
      </Typography.Text>
    );
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {setup.status === 'ready' ? (
        <Alert type="success" showIcon message="Paykit service image is ready." />
      ) : setup.status === 'building' ? (
        <>
          <Typography.Text>{setup.message}</Typography.Text>
          {setup.progress !== undefined && <Progress percent={setup.progress} />}
          <Button onClick={cancel}>Cancel build</Button>
        </>
      ) : (
        <Alert
          role="alert"
          type={setup.status === 'failed' ? 'error' : 'info'}
          showIcon
          message={setup.message}
          description={
            setup.error?.code === 'docker-unavailable'
              ? 'Open Docker Desktop and wait until it is running, then retry.'
              : 'The first build downloads dependencies and may take several minutes.'
          }
        />
      )}
      {setup.recentOutput.length > 0 && setup.status === 'building' && (
        <Typography.Paragraph
          aria-label="Build progress"
          style={{ maxHeight: 120, overflow: 'auto', whiteSpace: 'pre-wrap' }}
        >
          {setup.recentOutput.slice(-8).join('\n')}
        </Typography.Paragraph>
      )}
      {enableError && <Alert role="alert" type="error" message={enableError} showIcon />}
      {setup.status !== 'ready' && setup.status !== 'building' && (
        <Button type="primary" onClick={build}>
          {setup.status === 'needed' ? 'Build service image' : 'Retry setup'}
        </Button>
      )}
      {setup.status === 'ready' && onReady && (
        <Button type="primary" loading={enabling} disabled={disabled} onClick={enable}>
          Enable Paykit
        </Button>
      )}
    </Space>
  );
};

export default PaykitImageSetup;
