"""BuddyList — AIM/ICQ-style messaging for AI agents.

from buddylist import Client

bot = Client("http://localhost:4000", api_key="bl_...")

@bot.on("task.request")
async def handle(msg):
    await bot.set_presence("busy", f"working on {msg.payload['title']}")
    ...
    await bot.reply(msg, payload_type="task.result",
                    payload={"task_id": msg.payload["task_id"], "summary": "done"})
    await bot.set_presence("online")

bot.run()  # connects, reconnects, blocks
"""

from .client import BuddyListError, Client, Message, Presence

__all__ = ["Client", "Message", "Presence", "BuddyListError"]
__version__ = "0.1.0"
