import React from 'react';
import { act, fireEvent, waitFor } from '@testing-library/react';
import { newPaykitId, PaykitReceiverWorkspace } from 'shared/paykitApi';
import { renderWithProviders } from 'utils/tests';
import PaykitProfilesContacts from './PaykitProfilesContacts';

const receiverId = newPaykitId();
const peerPublicKey = 'y'.repeat(52);
const workspace: PaykitReceiverWorkspace = {
  receiverId,
  deliveryPaused: false,
  links: [],
  profiles: [],
  contacts: [],
  discoveries: [],
};
const png =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
const choose = (
  view: ReturnType<typeof renderWithProviders>,
  label: string,
  option: string,
) => {
  fireEvent.mouseDown(
    view.getAllByLabelText(label).find(element => element.tagName === 'INPUT')!,
  );
  fireEvent.click(view.getByText(option));
};
describe('Editable profiles and contacts', () => {
  it('publishes entered profile text and keeps the existing avatar by default', () => {
    const command = jest.fn();
    const view = renderWithProviders(
      <PaykitProfilesContacts
        receiverId={receiverId}
        workspace={workspace}
        disabled={false}
        command={command}
      />,
    );
    fireEvent.change(view.getByLabelText('Profile display name'), {
      target: { value: 'Alice public' },
    });
    fireEvent.change(view.getByLabelText('Profile about'), {
      target: { value: 'Editable biography' },
    });
    fireEvent.click(view.getByText('Publish profile'));
    expect(command).toHaveBeenCalledWith('profile.publish', {
      receiverId,
      displayName: 'Alice public',
      about: 'Editable biography',
    });
    choose(view, 'Profile avatar action', 'Remove avatar');
    fireEvent.click(view.getByText('Publish profile'));
    expect(command).toHaveBeenLastCalledWith('profile.publish', {
      receiverId,
      displayName: 'Alice public',
      about: 'Editable biography',
      avatarBase64: '',
      avatarMime: '',
    });
  });
  it('saves local contact arrays and fetches only the explicitly entered path', () => {
    const command = jest.fn();
    const view = renderWithProviders(
      <PaykitProfilesContacts
        receiverId={receiverId}
        workspace={workspace}
        disabled={false}
        command={command}
      />,
    );
    fireEvent.change(view.getByLabelText('Contact public key'), {
      target: { value: peerPublicKey },
    });
    fireEvent.change(view.getByLabelText('Contact label'), {
      target: { value: 'Bob work' },
    });
    fireEvent.change(view.getByLabelText('Contact receiver paths'), {
      target: { value: 'bob/wallet\nbob/server' },
    });
    expect(view.getByText('Fetch public profile').closest('button')).toBeDisabled();
    fireEvent.click(view.getByText('Save local contact'));
    expect(command).toHaveBeenCalledWith('contact.save', {
      receiverId,
      peerPublicKey,
      label: 'Bob work',
      receiverPaths: ['bob/wallet', 'bob/server'],
    });
    expect(command).not.toHaveBeenCalledWith('contact.publish', expect.anything());
    fireEvent.change(view.getByLabelText('Contact target receiver path'), {
      target: { value: 'bob/server' },
    });
    fireEvent.click(view.getByText('Fetch public profile'));
    expect(command).toHaveBeenLastCalledWith('profile.fetch', {
      receiverId,
      peerPublicKey,
      peerReceiverPath: 'bob/server',
    });
  });
  it.each(['publishing', 'public', 'removing', 'error'])(
    'requires unpublishing before changing a shared contact path (%s)',
    status => {
      const command = jest.fn();
      const view = renderWithProviders(
        <PaykitProfilesContacts
          receiverId={receiverId}
          workspace={{
            ...workspace,
            contacts: [
              {
                peerPublicKey,
                label: 'Bob',
                receiverPaths: ['bob/server'],
                publicSharing: status,
                publicReceiverPath: 'bob/server',
                lastError: 'Marker may remain',
              },
            ],
          }}
          disabled={false}
          command={command}
        />,
      );
      fireEvent.click(view.getByText('Edit contact'));
      fireEvent.change(view.getByLabelText('Contact target receiver path'), {
        target: { value: 'bob/wallet' },
      });
      expect(view.getByText('Share contact publicly').closest('button')).toBeDisabled();
      expect(view.getByText('Remove local contact').closest('button')).toBeDisabled();
      fireEvent.click(view.getByText('Unpublish contact'));
      expect(command).toHaveBeenCalledWith('contact.unpublish', {
        receiverId,
        peerPublicKey,
        peerReceiverPath: 'bob/server',
      });
      expect(view.getByText('Marker may remain')).toBeInTheDocument();
    },
  );
  it('rejects oversized or mismatched avatar files, then decodes and previews supported uploads', async () => {
    const originalImage = global.Image;
    const images: any[] = [];
    global.Image = class {
      naturalWidth = 1;
      naturalHeight = 1;
      constructor() {
        images.push(this);
      }
    } as any;
    try {
      const command = jest.fn();
      const view = renderWithProviders(
        <PaykitProfilesContacts
          receiverId={receiverId}
          workspace={workspace}
          disabled={false}
          command={command}
        />,
      );
      fireEvent.change(view.getByLabelText('Profile display name'), {
        target: { value: 'Alice' },
      });
      choose(view, 'Profile avatar action', 'Upload PNG / JPEG avatar');
      const input = view.getByLabelText('Avatar file');
      fireEvent.change(input, {
        target: {
          files: [
            new File([new Uint8Array(256 * 1024 + 1)], 'large.png', {
              type: 'image/png',
            }),
          ],
        },
      });
      expect(view.getByText(/Avatar must be a PNG/)).toBeInTheDocument();
      expect(view.getByText('Publish profile').closest('button')).toBeDisabled();
      fireEvent.change(input, {
        target: { files: [new File(['not png'], 'bad.png', { type: 'image/png' })] },
      });
      await view.findByText(/content does not match/);
      fireEvent.change(input, {
        target: {
          files: [
            new File([Buffer.from(png, 'base64')], 'good.png', { type: 'image/png' }),
          ],
        },
      });
      await waitFor(() => expect(images).toHaveLength(1));
      // A file signature is insufficient: browser decoding must finish successfully.
      expect(view.getByText('Publish profile').closest('button')).toBeDisabled();
      act(() => images[0].onerror());
      await view.findByText('Avatar image could not be decoded');
      expect(view.getByText('Publish profile').closest('button')).toBeDisabled();
      fireEvent.change(input, {
        target: {
          files: [
            new File([Buffer.from(png, 'base64')], 'retry.png', { type: 'image/png' }),
          ],
        },
      });
      await waitFor(() => expect(images).toHaveLength(2));
      act(() => images[1].onload());
      await view.findByAltText('Avatar upload preview');
      fireEvent.click(view.getByText('Publish profile'));
      expect(command).toHaveBeenCalledWith('profile.publish', {
        receiverId,
        displayName: 'Alice',
        about: '',
        avatarBase64: png,
        avatarMime: 'image/png',
      });
    } finally {
      global.Image = originalImage;
    }
  });
  it('never loads arbitrary profile image URIs, and displays validated public previews', () => {
    const profile = {
      peerPublicKey,
      peerReceiverPath: 'bob/server',
      displayName: 'Bob',
      about: 'Hello',
      imageUri: 'https://tracking.test/pixel',
      path: '/profile',
      updatedAt: 'today',
    };
    const view = renderWithProviders(
      <PaykitProfilesContacts
        receiverId={receiverId}
        workspace={{
          ...workspace,
          profile: { ...profile, avatarDataUrl: profile.imageUri },
          profiles: [
            {
              ...profile,
              displayName: 'Alice',
              avatarDataUrl: `data:image/png;base64,${png}`,
            },
          ],
        }}
        disabled={false}
        command={jest.fn()}
      />,
    );
    expect(view.queryByAltText('Bob avatar')).not.toBeInTheDocument();
    expect(view.getByAltText('Alice avatar')).toHaveAttribute(
      'src',
      `data:image/png;base64,${png}`,
    );
    expect(view.container.querySelector('img[src^="http"]')).toBeNull();
  });
});
