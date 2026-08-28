import EntityAvatar from './store/EntityAvatar';
import type {InstalledSkill} from '../lib/electron';

export default function SkillIcon({skill}: { skill: InstalledSkill }) {
    const author = skill.source?.id?.split('/')[0] || skill.name.charAt(0);

    return (
        <EntityAvatar
            name={skill.name}
            githubUsername={author}
            radius="lg"
        />
    );
}
