import React from 'react';
import { fireEvent, within } from '@testing-library/react';
import copy from 'copy-to-clipboard';
import { Status } from 'shared/types';
import { defaultStateInfo, getNetwork, renderWithProviders } from 'utils/tests';
import ConnectTab from './ConnectTab';

describe('Lightning connection clipboard', () => {
  it('copies distinct complete internal and external P2P addresses', () => {
    const network = getNetwork();
    const node = network.nodes.lightning[0];
    node.status = Status.Started;
    const pubkey = '02' + 'a'.repeat(64);
    const internal = `${pubkey}@polar-paykit-n1-alice:9735`;
    const external = `${pubkey}@127.0.0.1:${node.ports.p2p}`;
    const { getByText } = renderWithProviders(<ConnectTab node={node} />, {
      initialState: {
        network: { networks: [network] },
        lightning: {
          nodes: {
            [node.name]: { info: defaultStateInfo({ pubkey, rpcUrl: internal }) },
          },
        },
      },
    });
    const copyRow = (label: string) => {
      const row = getByText(label).closest('tr') as HTMLElement;
      fireEvent.click(within(row).getByLabelText('copy'));
    };
    copyRow('P2P Internal');
    expect(copy).toHaveBeenLastCalledWith(internal, undefined);
    copyRow('P2P External');
    expect(copy).toHaveBeenLastCalledWith(external, undefined);
  });
});
