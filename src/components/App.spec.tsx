import React from 'react';
import { render, waitFor } from '@testing-library/react';
import Dockerode from 'dockerode';
import App from './App';

jest.mock('dockerode');

const mockDockerode = Dockerode as unknown as jest.Mock<Dockerode>;

describe('App Component', () => {
  beforeEach(() => {
    // Exercise real app initialization without depending on the host Docker daemon.
    mockDockerode.prototype.version.mockResolvedValue({ Version: '29.0.0' });
    mockDockerode.prototype.listImages.mockResolvedValue([
      { RepoTags: ['polar-paykit/test-fixture:unit'] },
    ]);
  });
  it('renders without crashing', async () => {
    const { getByText, unmount } = render(<App />);
    await waitFor(() => {
      expect(getByText('Polar Paykit')).toBeInTheDocument();
    });
    expect(getByText('Docker v29.0.0')).toBeInTheDocument();
    expect(mockDockerode.prototype.version).toHaveBeenCalledTimes(1);
    expect(mockDockerode.prototype.listImages).toHaveBeenCalledTimes(1);
    unmount();
  });
});
