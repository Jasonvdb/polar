import React, { useState } from 'react';
import { Alert, Button, Card, Input, List, Select, Space, Tag, Typography } from 'antd';
import { PaykitProfile, safePaykitAvatar, validatePaykitAvatar } from 'shared/paykitApi';
import { PaykitReceiverPanelProps } from './PaykitLinks';

const Profile: React.FC<{ profile: PaykitProfile }> = ({ profile }) => (
  <div>
    <Typography.Title level={5}>{profile.displayName}</Typography.Title>
    {safePaykitAvatar(profile.avatarDataUrl) && (
      <img
        src={profile.avatarDataUrl}
        alt={`${profile.displayName} avatar`}
        width={80}
        height={80}
        style={{ objectFit: 'contain' }}
      />
    )}
    <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
      {profile.about}
    </Typography.Paragraph>
    <Typography.Paragraph>
      Owner: {profile.peerPublicKey} / {profile.peerReceiverPath}
    </Typography.Paragraph>
    <Typography.Paragraph>
      Profile: <Typography.Text copyable>{profile.path}</Typography.Text>
    </Typography.Paragraph>
    {profile.imageUri && (
      <Typography.Paragraph>
        Avatar URI: <Typography.Text copyable>{profile.imageUri}</Typography.Text>
      </Typography.Paragraph>
    )}
    <Typography.Text type="secondary">Updated {profile.updatedAt}</Typography.Text>
  </div>
);
const PaykitProfilesContacts: React.FC<PaykitReceiverPanelProps> = ({
  receiverId,
  workspace,
  disabled,
  command,
}) => {
  const [displayName, setName] = useState('');
  const [about, setAbout] = useState('');
  const [avatarMode, setAvatarMode] = useState('retain');
  const [avatar, setAvatar] = useState<{ avatarBase64: string; avatarMime: string }>();
  const [avatarError, setAvatarError] = useState('');
  const [avatarLoading, setAvatarLoading] = useState(false);
  const [peerPublicKey, setKey] = useState('');
  const [peerReceiverPath, setPath] = useState('');
  const [label, setLabel] = useState('');
  const [paths, setPaths] = useState('');
  const peer = { receiverId, peerPublicKey: peerPublicKey.trim() };
  const target = { ...peer, peerReceiverPath: peerReceiverPath.trim() };
  const contact = workspace?.contacts.find(
    item => item.peerPublicKey === peer.peerPublicKey,
  );
  const isPrivate = !contact || contact.publicSharing === 'private';
  const loadAvatar = (file?: File) => {
    setAvatar(undefined);
    setAvatarError('');
    if (!file) return;
    if (file.size > 256 * 1024 || !['image/png', 'image/jpeg'].includes(file.type)) {
      setAvatarError('Avatar must be a PNG or JPEG up to 256 KiB');
      return;
    }
    setAvatarLoading(true);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const base64 = Buffer.from(reader.result as ArrayBuffer).toString('base64');
        validatePaykitAvatar(base64, file.type);
        const preview = new Image();
        preview.onload = () => {
          if (
            preview.naturalWidth > 0 &&
            preview.naturalHeight > 0 &&
            preview.naturalWidth <= 1024 &&
            preview.naturalHeight <= 1024
          ) {
            setAvatar({ avatarBase64: base64, avatarMime: file.type });
          } else
            setAvatarError('Avatar must decode to an image no larger than 1024 × 1024');
          setAvatarLoading(false);
        };
        preview.onerror = () => {
          setAvatarError('Avatar image could not be decoded');
          setAvatarLoading(false);
        };
        preview.src = `data:${file.type};base64,${base64}`;
        return;
      } catch (error: any) {
        setAvatarError(error.message);
      }
      setAvatarLoading(false);
    };
    reader.onerror = () => {
      setAvatarError('Avatar file could not be read');
      setAvatarLoading(false);
    };
    reader.readAsArrayBuffer(file);
  };
  return (
    <>
      <Card title="Profiles" style={{ marginTop: 12 }}>
        <Typography.Paragraph>
          Publish a public profile in this receiver’s namespace. A local contact label is
          separate from its public profile.
        </Typography.Paragraph>
        {workspace?.profile ? (
          <Profile profile={workspace.profile} />
        ) : (
          <p>No published profile for this receiver.</p>
        )}
        <Space direction="vertical" style={{ width: '100%' }}>
          <Button
            disabled={!workspace?.profile}
            onClick={() => {
              setName(workspace!.profile!.displayName);
              setAbout(workspace!.profile!.about);
            }}
          >
            Edit published profile
          </Button>
          <Input
            aria-label="Profile display name"
            placeholder="Public display name"
            maxLength={80}
            value={displayName}
            onChange={e => setName(e.target.value)}
          />
          <Input.TextArea
            aria-label="Profile about"
            placeholder="About"
            maxLength={2000}
            value={about}
            onChange={e => setAbout(e.target.value)}
          />
          <Select
            aria-label="Profile avatar action"
            value={avatarMode}
            onChange={setAvatarMode}
            style={{ minWidth: 220 }}
          >
            <Select.Option value="retain">Keep current avatar</Select.Option>
            <Select.Option value="upload">Upload PNG / JPEG avatar</Select.Option>
            <Select.Option value="remove">Remove avatar</Select.Option>
          </Select>
          {avatarMode === 'upload' && (
            <>
              <label>
                Avatar file (PNG/JPEG, up to 256 KiB and 1024 × 1024)
                <input
                  aria-label="Avatar file"
                  type="file"
                  accept="image/png,image/jpeg"
                  disabled={avatarLoading}
                  onChange={e => loadAvatar(e.target.files?.[0])}
                />
              </label>
              {avatar && (
                <img
                  src={`data:${avatar.avatarMime};base64,${avatar.avatarBase64}`}
                  alt="Avatar upload preview"
                  width={80}
                  height={80}
                  style={{ objectFit: 'contain' }}
                />
              )}
              {avatarError && <Alert type="error" message={avatarError} />}
            </>
          )}
          <Space wrap>
            <Button
              disabled={
                disabled ||
                !displayName.trim() ||
                avatarLoading ||
                (avatarMode === 'upload' && !avatar)
              }
              onClick={() =>
                command('profile.publish', {
                  receiverId,
                  displayName: displayName.trim(),
                  about,
                  ...(avatarMode === 'upload'
                    ? avatar
                    : avatarMode === 'remove'
                    ? { avatarBase64: '', avatarMime: '' }
                    : {}),
                })
              }
            >
              Publish profile
            </Button>
            <Button
              danger
              disabled={disabled || !workspace?.profile}
              onClick={() => command('profile.delete', { receiverId })}
            >
              Delete published profile
            </Button>
          </Space>
        </Space>
      </Card>
      <Card title="Contacts and profile discovery" style={{ marginTop: 12 }}>
        <Typography.Paragraph>
          Save contacts locally, discover their receiver paths, and fetch a profile at an
          explicit path. Public sharing is opt-in per contact.
        </Typography.Paragraph>
        <Space direction="vertical" style={{ width: '100%' }}>
          <Input
            aria-label="Contact public key"
            placeholder="Contact public key"
            value={peerPublicKey}
            onChange={e => setKey(e.target.value)}
          />
          <Input
            aria-label="Contact label"
            placeholder="Local contact label"
            maxLength={80}
            value={label}
            onChange={e => setLabel(e.target.value)}
          />
          <Input.TextArea
            aria-label="Contact receiver paths"
            placeholder="Receiver paths, one per line"
            value={paths}
            onChange={e => setPaths(e.target.value)}
          />
          <Input
            aria-label="Contact target receiver path"
            placeholder="Explicit receiver path to fetch or share"
            value={peerReceiverPath}
            onChange={e => setPath(e.target.value)}
          />
          <Space wrap>
            <Button
              disabled={disabled || !peer.peerPublicKey || !paths.trim()}
              onClick={() =>
                command('contact.save', {
                  ...peer,
                  label,
                  receiverPaths: paths
                    .split('\n')
                    .map(path => path.trim())
                    .filter(Boolean),
                })
              }
            >
              Save local contact
            </Button>
            <Button
              disabled={disabled || !peer.peerPublicKey}
              onClick={() => command('contact.discover', peer)}
            >
              Discover receiver paths
            </Button>
            <Button
              disabled={disabled || !peer.peerPublicKey || !target.peerReceiverPath}
              onClick={() => command('profile.fetch', target)}
            >
              Fetch public profile
            </Button>
            <Button
              disabled={disabled || !contact || !target.peerReceiverPath || !isPrivate}
              onClick={() => command('contact.publish', target)}
            >
              Share contact publicly
            </Button>
            <Button
              disabled={disabled || !contact || isPrivate || !contact.publicReceiverPath}
              onClick={() =>
                command('contact.unpublish', {
                  ...peer,
                  peerReceiverPath: contact!.publicReceiverPath!,
                })
              }
            >
              Unpublish contact
            </Button>
            <Button
              danger
              disabled={disabled || !contact || !isPrivate}
              onClick={() => command('contact.remove', peer)}
            >
              Remove local contact
            </Button>
          </Space>
        </Space>
        {!isPrivate && (
          <Alert
            type="info"
            message="Unpublish the contact before removing it or a shared receiver path. Pending or failed sharing may still have a public marker."
          />
        )}
        <List
          dataSource={workspace?.contacts || []}
          locale={{ emptyText: 'No local contacts for this receiver' }}
          renderItem={item => (
            <List.Item>
              <div>
                <Typography.Text strong>
                  {item.label || 'Unlabelled contact'}
                </Typography.Text>{' '}
                <Tag>{item.publicSharing}</Tag>
                <p>{item.peerPublicKey}</p>
                <p>{item.receiverPaths.join(', ')}</p>
                {item.publicReceiverPath && (
                  <p>Publicly shared receiver: {item.publicReceiverPath}</p>
                )}
                {item.lastError && <Alert type="error" message={item.lastError} />}
                <Button
                  onClick={() => {
                    setKey(item.peerPublicKey);
                    setLabel(item.label);
                    setPaths(item.receiverPaths.join('\n'));
                    setPath(item.publicReceiverPath || '');
                  }}
                >
                  Edit contact
                </Button>
              </div>
            </List.Item>
          )}
        />
        <List
          header="Discovered receiver paths"
          dataSource={workspace?.discoveries || []}
          renderItem={item => (
            <List.Item>
              <div>
                <p>{item.peerPublicKey}</p>
                <p>{item.receiverPaths.join(', ') || 'No published receivers'}</p>
                <Typography.Text type="secondary">
                  Fetched {item.updatedAt}
                </Typography.Text>
                <br />
                <Button
                  onClick={() => {
                    setKey(item.peerPublicKey);
                    setPaths(item.receiverPaths.join('\n'));
                    setLabel('');
                    setPath('');
                  }}
                >
                  Use discovered paths in draft
                </Button>
              </div>
            </List.Item>
          )}
        />
        <List
          header="Fetched public profiles"
          dataSource={workspace?.profiles || []}
          renderItem={profile => (
            <List.Item>
              <Profile profile={profile} />
            </List.Item>
          )}
        />
      </Card>
    </>
  );
};
export default PaykitProfilesContacts;
