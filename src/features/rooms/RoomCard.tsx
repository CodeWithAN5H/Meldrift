import { Gamepad2, Headphones, Users } from 'lucide-react';
import { colorFor, vars, type Room } from '@/lib/model';
import { relativeTime } from '@/lib/format';

export function RoomCard({
  room,
  onOpen,
  compact,
}: {
  room: Room;
  onOpen: () => void;
  compact?: boolean;
}) {
  const accent = colorFor(room.id);
  return (
    <button
      type="button"
      className="md-roomcard"
      data-compact={compact}
      onClick={onOpen}
    >
      <span
        className="md-roomcard__tile"
        style={vars({ '--tile-a': accent })}
        aria-hidden="true"
      >
        {room.kind === 'game' ? <Gamepad2 size={21} /> : <Headphones size={21} />}
      </span>
      <span className="md-roomcard__body">
        <span className="md-roomcard__name">{room.name}</span>
        <span className="md-roomcard__meta">
          <Users size={11} />1 member
          <span className="md-roomcard__sep" aria-hidden="true">·</span>
          {room.kind === 'game' ? room.gameTitle ?? 'Game room' : 'Voice room'}
        </span>
      </span>
      <span className="md-roomcard__foot">
        {relativeTime(room.lastActiveAt)}
      </span>
    </button>
  );
}
