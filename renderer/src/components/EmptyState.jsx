import { EMPTY_DEFAULT } from '../strings';

export default function EmptyState({ message }) {
  return (
    <div className="empty-state">
      <p>{message || EMPTY_DEFAULT}</p>
    </div>
  );
}
