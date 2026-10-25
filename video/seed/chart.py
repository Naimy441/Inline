# Wave height across three shoreline types, for the demo thesis document.
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
plt.rcParams.update({"font.family": "Helvetica", "font.size": 11})
x = np.linspace(0, 60, 200)
fig, ax = plt.subplots(figsize=(7.2, 3.6), dpi=220)
for k, label, c in [(0.004, "Bulkhead", "#9aa0a6"), (0.018, "Oyster reef sill", "#c96442"), (0.031, "Marsh + sill", "#2f6f5e")]:
    ax.plot(x, 0.82 * np.exp(-k * x), lw=2.4, color=c, label=label)
ax.set_xlabel("Distance shoreward (m)")
ax.set_ylabel("Significant wave height (m)")
ax.spines[["top", "right"]].set_visible(False)
ax.grid(axis="y", color="#e6e2dc", lw=0.8)
ax.set_ylim(0, 0.9); ax.set_xlim(0, 60)
ax.legend(frameon=False, loc="upper right")
fig.tight_layout()
fig.savefig("/Users/naim/Desktop/Inline/video/seed/wave-chart.png", facecolor="white")
