import EntityAvatar from './store/EntityAvatar';
import type {InstalledServer} from '../pages/Library';
import type {ServerListItem} from '../api/registry';

export default function ServerIcon({server, serverInfo}: { server: InstalledServer; serverInfo?: ServerListItem }) {
    const displayName = serverInfo?.displayName || server.id.split('/').pop() || server.id;
    const repoUrl = serverInfo?.repository?.url;
    const githubUsername = repoUrl?.match(/github\.com\/([^\/]+)/)?.[1] ?? null;

    return (
        <EntityAvatar
            name={displayName}
            iconUrl={serverInfo?.iconUrl}
            githubUsername={githubUsername}
            radius="lg"
        />
    );
}
