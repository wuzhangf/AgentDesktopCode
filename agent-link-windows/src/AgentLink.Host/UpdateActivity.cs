namespace AgentLink;

/// <summary>Coordinates local file and connector operations with an exclusive installation reservation.</summary>
internal sealed class UpdateActivity
{
    private readonly object sync = new();
    private int activities;
    private bool held;
    private bool uncertain;

    internal bool Held { get { lock (sync) return held; } }

    internal IDisposable? Enter()
    {
        lock (sync)
        {
            if (held) return null;
            activities++;
            return new Lease(this, reservation: false);
        }
    }

    internal IDisposable? Reserve()
    {
        lock (sync)
        {
            if (held || uncertain || activities != 0) return null;
            held = true;
            return new Lease(this, reservation: true);
        }
    }

    internal void MarkUnconfirmed()
    {
        lock (sync) uncertain = true;
    }

    private void Leave(bool reservation)
    {
        lock (sync)
        {
            if (reservation) held = false;
            else activities--;
        }
    }

    private sealed class Lease(UpdateActivity owner, bool reservation) : IDisposable
    {
        private UpdateActivity? owner = owner;
        public void Dispose() => Interlocked.Exchange(ref owner, null)?.Leave(reservation);
    }
}
