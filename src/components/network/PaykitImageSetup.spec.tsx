import React from 'react';
import { fireEvent, render, waitFor } from '@testing-library/react';
import { paykitService } from 'lib/paykit/paykitService';
import PaykitImageSetup from './PaykitImageSetup';

jest.mock('lib/paykit/paykitService');
const service = paykitService as jest.Mocked<typeof paykitService>;

describe('Paykit image setup', () => {
  test('does not enable before the exact image is ready and supports retry', async () => {
    service.imageStatus.mockResolvedValue({
      status: 'failed',
      message: 'Start Docker Desktop, then retry.',
      recentOutput: [],
      error: { code: 'docker-unavailable', message: 'Start Docker Desktop, then retry.' },
    });
    service.buildImage.mockResolvedValue({
      status: 'needed',
      message: 'Build the service image',
      recentOutput: [],
    });
    const enable = jest.fn().mockResolvedValue(undefined);
    const view = render(<PaykitImageSetup onReady={enable} />);
    fireEvent.click(await view.findByText('Retry setup'));
    await waitFor(() => expect(service.buildImage).toHaveBeenCalledTimes(1));
    expect(enable).not.toHaveBeenCalled();
  });

  test('cancels only the active build job', async () => {
    service.imageStatus.mockResolvedValue({
      status: 'building',
      jobId: 'job-1',
      phase: 'building-image',
      message: 'Building',
      recentOutput: [],
    });
    service.cancelImageBuild.mockResolvedValue({
      status: 'building',
      jobId: 'job-1',
      message: 'Cancelling',
      recentOutput: [],
    });
    const view = render(<PaykitImageSetup onReady={jest.fn()} />);
    fireEvent.click(await view.findByText('Cancel build'));
    await waitFor(() => expect(service.cancelImageBuild).toHaveBeenCalledWith('job-1'));
  });

  test('enables after ready validation', async () => {
    service.imageStatus.mockResolvedValue({
      status: 'ready',
      message: 'Ready',
      recentOutput: [],
      imageTag: 'polar-paykit/service:test',
    });
    const enable = jest.fn().mockResolvedValue(undefined);
    const view = render(<PaykitImageSetup onReady={enable} />);
    fireEvent.click(await view.findByText('Enable Paykit'));
    await waitFor(() => expect(enable).toHaveBeenCalledTimes(1));
  });

  test('shows retained output and memory guidance after a build failure', async () => {
    service.imageStatus.mockResolvedValue({
      status: 'failed',
      message: 'The service image build failed.',
      recentOutput: ['The command returned a non-zero code: 101'],
      error: { code: 'build-failed', message: 'The service image build failed.' },
    });

    const view = render(<PaykitImageSetup onReady={jest.fn()} />);

    expect(await view.findByLabelText('Build output')).toHaveTextContent(
      'non-zero code: 101',
    );
    expect(view.getByText(/at least 4 GB of memory/)).toBeInTheDocument();
  });
});
