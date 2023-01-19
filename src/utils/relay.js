export class Relay {
  constructor() {
    this.relays = [
      "https://www.firn.link",
    ];
  }

  async fetch(endpoint, body) { // wraps regular fetch.
    // not doing any timeout for now.
    let stored;
    for (let i = 0; i < this.relays.length; i++) {
      const init = {
        method: "POST",
        mode: "cors", // is this necessary?!? check.
        headers: {
          "Content-Type": "application/json"
        },
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      try {
        const response = await fetch(`${this.relays[i]}/${endpoint}`, init);
        if (!response.ok) throw response; // does this ever happen?
        return await response.json();
      } catch (error) {
        console.error(error);
        stored = error;
      }
    }
    throw stored;
  }
}
