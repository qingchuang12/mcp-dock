import { useState } from 'react';

const COLORS = [
  'bg-blue-500',
  'bg-purple-500',
  'bg-green-500',
  'bg-orange-500',
  'bg-pink-500',
  'bg-cyan-500',
];

interface EntityAvatarProps {
  name: string;
  iconUrl?: string | null;
  githubUsername?: string | null;
  size?: number;
  radius?: 'lg' | 'xl';
}

export default function EntityAvatar({
  name,
  iconUrl,
  githubUsername,
  size = 9,
  radius = 'xl',
}: EntityAvatarProps) {
  const [imgError, setImgError] = useState(false);
  const [avatarError, setAvatarError] = useState(false);

  const initial = name.charAt(0).toUpperCase();
  const colorIndex = name.charCodeAt(0) % COLORS.length;
  const sizeClass = `w-${size} h-${size}`;
  const radiusClass = radius === 'lg' ? 'rounded-lg' : 'rounded-xl';
  const imgClass = `${sizeClass} ${radiusClass} object-cover`;

  if (iconUrl && !imgError) {
    return (
      <img
        src={iconUrl}
        alt={name}
        className={imgClass}
        onError={() => setImgError(true)}
      />
    );
  }

  if (githubUsername && !avatarError) {
    return (
      <img
        src={`https://avatars.githubusercontent.com/${githubUsername}`}
        alt={name}
        className={imgClass}
        onError={() => setAvatarError(true)}
      />
    );
  }

  return (
    <div
      className={`${sizeClass} ${radiusClass} ${COLORS[colorIndex]} flex items-center justify-center text-[var(--color-text)] font-semibold text-sm`}
    >
      {initial}
    </div>
  );
}
