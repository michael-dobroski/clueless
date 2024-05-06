import { sql } from "@vercel/postgres";
import { NextResponse } from 'next/server';

{/***************
  * This is more of a proof of concept than anything.
  * Page updates every 5 seconds by sending a "fetchstatus" POST to this API.
  * API then returns the turncount.
  * This turncount can be incremented by any player sending anything in the chatbox.
  * This shows that the text-based Clueless game can be seamlessly updated and demonstrates how to interact with the API.
  * 
  * As a reminder, our APIs are REST so we don't save state other than in the database.
  * So every call to this API must contain the gameid, email (user intentifier), and playerMove (gives insight into the player's move)
  ***************/}

export async function POST (request: Request) { // this will contain most game logic so keep it tidy! functions wherever you can

  try {

    // get player move info and log
    const { gameid, email, playerMove }: GameRequestBody = await request.json();
    // console.log("email: ", email, "playerMove: ", playerMove);

    // get current player's turn info and player coords at start b/c it will get used in a lot of cases
    let playerTurnEmail = await whoseTurnIsIt(gameid);
    let playerCoords = await getAllPlayerCoords(gameid);
    let mostRecentAction = await getMostRecentAction(gameid);

    // if it's a fetchStatus call (representing a 5 sec refresh), return the turn count and all player locations
    // @todo change it so that we don't have to send all player locations, only the most recent
    if (email.toLowerCase() === "fetchstatus" && playerMove.toLowerCase() === "fetchstatus") {
      return NextResponse.json({ result: "Refresh...", currentTurn: playerTurnEmail, playerCoords: playerCoords, mostRecentAction: mostRecentAction }, {status: 200});
    }

    // if it's not their turn, tell them so
    if (!(await isPlayerTurn(gameid, email))) {
      return NextResponse.json({ result: "Sorry, it's not your turn.", currentTurn: playerTurnEmail, playerCoords: playerCoords, mostRecentAction: mostRecentAction }, {status: 200});
    }

    if ((await getGameStatus(gameid)) === "move?") {

      // input is a player move, so process it
      const movePlayerResult = await processPlayerMove(playerMove, email, gameid);

      // if move is valid (meaning both good input and the space is available)
      if (movePlayerResult === "success") {
        playerCoords = await getAllPlayerCoords(gameid);
        mostRecentAction = await getMostRecentAction(gameid);
        if ((await isPlayerInRoom(gameid, email)) !== null) { // divert game flow to allow player to make a suggestion if player is in a room
          await setGameStatus(gameid, 'suggest?');
          return NextResponse.json({ result: "Success. Make a suggestion?", currentTurn: playerTurnEmail, playerCoords: playerCoords, mostRecentAction: mostRecentAction }, { status: 200 });
        }
        await setGameStatus(gameid, 'accuse?');
        return NextResponse.json({ result: "Success. Make an accusation?", currentTurn: playerTurnEmail, playerCoords: playerCoords, mostRecentAction: mostRecentAction }, { status: 200 });
      }

      return NextResponse.json({ result: movePlayerResult, currentTurn: playerTurnEmail, playerCoords: playerCoords, mostRecentAction: mostRecentAction }, { status: 200 });

    }

    if ((await getGameStatus(gameid)) === "suggest?") { // for minimal increment, showing cards after a suggestion is automatic. it chooses one random refutal card if they have one. @todo in target, we will allow players to choose which card they'd like to show the suggestor

      if (playerMove === "no") { // player opted not to suggest. change game state to "accuse?"
        await setGameStatus(gameid, 'accuse?');
        return NextResponse.json({ result: "Okay! Make an accusation?", currentTurn: playerTurnEmail, playerCoords: playerCoords, mostRecentAction: mostRecentAction }, { status: 200 });
      }

      const suggestionResult = await processPlayerSuggestion(playerMove, email, gameid);

      if (suggestionResult === "invalid") {
        return NextResponse.json({ result: "Sorry, invalid input. Make sure you select every option. Room will be the one you're already in.", currentTurn: playerTurnEmail, playerCoords: playerCoords, mostRecentAction: mostRecentAction }, { status: 200 });
      }

      await setGameStatus(gameid, 'accuse?');
      playerCoords = await getAllPlayerCoords(gameid);
      mostRecentAction = await getMostRecentAction(gameid);
      return NextResponse.json({ result: suggestionResult + "Make an accusation?", currentTurn: playerTurnEmail, playerCoords: playerCoords, mostRecentAction: mostRecentAction }, { status: 200 });
    }

    if ((await getGameStatus(gameid)) === "accuse?") {

      if (playerMove === "no") { // player opted not to accuse. change game state to "move?" and update turn
        await setGameStatus(gameid, 'move?');
        playerTurnEmail = await updateTurn(gameid);
        return NextResponse.json({ result: "Okay!", currentTurn: playerTurnEmail, playerCoords: playerCoords, mostRecentAction: mostRecentAction }, { status: 200 });
      }

      const accusationResult = await processPlayerAccusation(playerMove, email, gameid);

      if (accusationResult === "invalid") {
        return NextResponse.json({ result: "Sorry, invalid input. Make sure you select every option.", currentTurn: playerTurnEmail, playerCoords: playerCoords, mostRecentAction: mostRecentAction }, { status: 200 });
      }

      if (accusationResult === "false") {
        await deactivatePlayer(gameid, email);
        playerTurnEmail = await updateTurn(gameid);
        await setGameStatus(gameid, 'move?');
        if (await isGameOver(gameid)) {
          // set SolutionRevealed BOOLEAN in the Games table to true
          await setSolutionRevealed(gameid);
          // change gameState to 'done'
          await setGameStatus(gameid, 'done');
          // display to the rest of players who has won and what the solution was
          const winnerEmail = await getWinner(gameid);
          await appendMostRecentAction(gameid, "The game is over as a result of elimination. " + winnerEmail + " won!");
          mostRecentAction = await getMostRecentAction(gameid);
          return NextResponse.json({ result: "You lost, and the game is over.", currentTurn: playerTurnEmail, playerCoords: playerCoords, mostRecentAction: mostRecentAction }, { status: 200 });
        }
        mostRecentAction = await getMostRecentAction(gameid);
        return NextResponse.json({ result: "You lost.", currentTurn: playerTurnEmail, playerCoords: playerCoords, mostRecentAction: mostRecentAction }, { status: 200 });
      }

      if (accusationResult === "true") {
        // set SolutionRevealed BOOLEAN in the Games table to true
        await setSolutionRevealed(gameid);
        // change gameState to 'done'
        await setGameStatus(gameid, 'done');
        // display to the rest of players who has won and what the solution was
        mostRecentAction = await getMostRecentAction(gameid);
        return NextResponse.json({ result: "You won!", currentTurn: playerTurnEmail, playerCoords: playerCoords, mostRecentAction: mostRecentAction }, { status: 200 });
      }
    }

    // if you've made it to the end, then something went wrong. invalid game state maybe?
    return NextResponse.json({ result: "Sorry, something went wrong.", currentTurn: playerTurnEmail, playerCoords: playerCoords, mostRecentAction: mostRecentAction }, { status: 200 });

  } catch (error) {
    return NextResponse.json({error}, {status: 500});
  }

}

export async function PUT (request: Request) {

  try {

    const { gameid, email } = await request.json();

    // if this is host, then set up everyone's turn order, character, and distribute cards
    const { rows: game } = await sql`SELECT * FROM Games WHERE gameid = ${gameid} LIMIT 1`;
    if ((game[0].gameowner === email ?? "") && game[0].gamestate == 'open') {

      const { playerCount, playerEmails } = await getPlayerCountEmails(gameid);

      // close the game state from new players joining and set TurnCount
      // anything that isn't 'open' corresponds to 'closed'. we use this field to indicate what type of turn a player can make. we always start with a move
      await sql`
        UPDATE Games
        SET GameState = 'move?', TurnCount = ${playerCount}
        WHERE GameID = ${gameid}`;

      const { solutionCards, playerCards, playerCharacters } = distributeClueCards(playerCount, allClueCards);

      await setSolutionCards(gameid, solutionCards);
      await setPlayerCards(playerEmails, playerCards);
      await setPlayerTurns(playerEmails);
      await setPlayerCharacters(playerEmails, playerCharacters);
      await setMostRecentAction(gameid, "Let's begin!");

      const playerRooms = getRandomRooms(playerCount);
      await setPlayerCoords(playerEmails, playerRooms, gameid);

    }

    // fetch the cards at $email plus player locations and return them to the game component
    const playerCardsRet = await getPlayerCards(email);
    const playerCoordsRet = await getAllPlayerCoords(gameid);
    const playerCharactersRet = await fetchPlayersWithCharacters(gameid);
    const playerIconsRet = await fetchPlayersWithIcons(gameid);
    return NextResponse.json({ playerCards: playerCardsRet, playerCoords: playerCoordsRet, playerCharacters : playerCharactersRet, playerIcons : playerIconsRet }, { status: 200 });

  } catch (error) {
    return NextResponse.json({error}, {status: 500});
  }

}

type GameRequestBody = {
  gameid: string;
  email: string;
  playerMove: string;
};

const allClueCards: string[][] = [
  ['Weapon', 'Revolver'],
  ['Weapon', 'Candlestick'],
  ['Weapon', 'Knife'],
  ['Weapon', 'Lead Pipe'],
  ['Weapon', 'Wrench'],
  ['Weapon', 'Rope'],
  ['Suspect', 'Miss Scarlet'],
  ['Suspect', 'Professor Plum'],
  ['Suspect', 'Mrs. Peacock'],
  ['Suspect', 'Mr. Green'],
  ['Suspect', 'Colonel Mustard'],
  ['Suspect', 'Mrs. White'],
  ['Room', 'Kitchen'],
  ['Room', 'Ballroom'],
  ['Room', 'Conservatory'],
  ['Room', 'Dining Room'],
  ['Room', 'Billiard Room'],
  ['Room', 'Library'],
  ['Room', 'Lounge'],
  ['Room', 'Hall'],
  ['Room', 'Study']
];

const hallways: number[][] = [
  [1, 0],
  [3, 0],
  [0, 1],
  [2, 1],
  [4, 1],
  [1, 2],
  [3, 2],
  [0, 3],
  [2, 3],
  [4, 3],
  [1, 4],
  [3, 4]
]

const rooms: number[][] = [
  [0, 0],
  [2, 0],
  [4, 0],
  [0, 2],
  [2, 2],
  [4, 2],
  [0, 4],
  [2, 4],
  [4, 4]
]

const blankSpaces: number[][] = [
  [1, 1],
  [3, 1], 
  [1, 3],
  [3, 3]
]

function shuffleArray(array: string[][]): string[][] {
  const shuffledArray = array.slice();
  for (let i = shuffledArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffledArray[i], shuffledArray[j]] = [shuffledArray[j], shuffledArray[i]];
  }
  return shuffledArray;
}

function distributeClueCards(numberOfPlayers: number, allClueCards: string[][]): { solutionCards: string[][], playerCards: string[][][], playerCharacters: string[] } {
  // Create an array of arrays to hold the cards for each player
  const playerCards: string[][][] = new Array(numberOfPlayers).fill([]).map(() => []);

  // Shuffle the Clue cards
  const shuffledCards = shuffleArray(allClueCards);

  // Calculate how many cards each player should get
  const cardsPerPlayer = Math.floor((shuffledCards.length - 3) / numberOfPlayers);

  // Put away one card of each type for the solution
  const solutionCards: string[][] = [];
  const remainingCards: string[][] = [];

  for (const card of shuffledCards) {
    if (solutionCards.length < 3 && !solutionCards.some((c) => c[0] === card[0])) {
      solutionCards.push(card);
    } else {
      remainingCards.push(card);
    }
  }

  // Distribute cards to each player
  for (let i = 0; i < numberOfPlayers; i++) {
    const startIndex = i * cardsPerPlayer;
    const endIndex = (i + 1) * cardsPerPlayer;
    playerCards[i] = remainingCards.slice(startIndex, endIndex);
  }

  // Distribute any remaining cards to players starting from the first player
  let currentPlayerIndex = 0;
  for (const card of remainingCards.slice(cardsPerPlayer * numberOfPlayers)) {
    playerCards[currentPlayerIndex].push(card);
    currentPlayerIndex = (currentPlayerIndex + 1) % numberOfPlayers;
  }

  // Get 'numberOfPlayers' characters randomly
  const shuffledCharacters = suspectNames.sort(() => Math.random() - 0.5);
  const playerCharacters = shuffledCharacters.slice(0, numberOfPlayers);

  return { solutionCards, playerCards, playerCharacters };
}

async function getPlayerCountEmails(gameid: string): Promise<{ playerCount: number, playerEmails: string[] }> {
  try {
    // Run the SQL query to get the player count and emails
    const { rows } = await sql`
      SELECT 
        COUNT(*) as playerCount,
        ARRAY_AGG(email) as playerEmails
      FROM Players 
      WHERE gameid = ${gameid};
    `;

    const playerCount = rows[0].playercount;
    const playerEmails = rows[0].playeremails || [];

    return { playerCount, playerEmails };
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function getPlayerCards(email: string): Promise<string[][]> {
  try {
    // Run the SQL query to get the updated player information
    const updatedPlayer = await sql`
      SELECT *
      FROM Players
      WHERE email = ${email};
    `;

    // Define a regular expression to match the elements
    const regex = /\['(.*?)', '(.*?)'\]/g;

    const resultArray: string[][] = [];

    // Use a loop to extract the elements using the regex
    let match;
    while ((match = regex.exec(updatedPlayer.rows[0].cards)) !== null) {
      const [, category, value] = match;
      resultArray.push([category, value]);
    }

    return resultArray;
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function setPlayerCards(playerEmails: string[], playerCards: string[][][]): Promise<void> {

  try {
    let i = 0;
    for (const email of playerEmails) {

      // Get the cards array for the current player
      const cardsArray = playerCards[i];
      const cardsString = cardsArray.map(innerArray => `ARRAY['${innerArray.join("', '")}']`).join(',');

      // Run the SQL query to update player cards
      await sql`
        UPDATE Players
        SET cards = ARRAY[${cardsString}]
        WHERE email = ${email};`;

      i++;
    }
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }

}

async function setPlayerTurns(playerEmails: string[]): Promise<void> {

  try {
    let i = 1;
    for (const email of playerEmails) {
      await sql`
        UPDATE Players
        SET TurnOrder = ${i}, Active = true
        WHERE email = ${email}`
      i++;
    }
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }

}

async function setPlayerCharacters(playerEmails: string[], playerCharacters: string[]): Promise<void> {

  try {
    let i = 0;
    for (const email of playerEmails) {
      await sql`
        UPDATE Players
        SET character = ${playerCharacters[i]}
        WHERE email = ${email}`
      i++;
    }
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }

}

async function getPlayerCharacter(email: string): Promise<string> {
  try {
    // Run the SQL query to get the updated player information
    const updatedPlayer = await sql`
      SELECT *
      FROM Players
      WHERE email = ${email};
    `;

    return updatedPlayer.rows[0].character;
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function setSolutionCards(gameid: string, solutionCards: string[][]): Promise<void> {

  try {
    const cardsString = solutionCards.map(innerArray => `ARRAY['${innerArray.join("', '")}']`).join(',');

    // Run the SQL query to update solution cards
    await sql`
      UPDATE Games
      SET solution = ARRAY[${cardsString}]
      WHERE GameID = ${gameid};`;

  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }

}

async function getSolutionCards(gameid: string): Promise<string[][]> {
  try {
    // Run the SQL query to get the updated player information
    const solutionCards = await sql`
      SELECT *
      FROM Games
      WHERE GameID = ${gameid};
    `;

    // Define a regular expression to match the elements
    const regex = /\['(.*?)', '(.*?)'\]/g;

    const resultArray: string[][] = [];

    // Use a loop to extract the elements using the regex
    let match;
    while ((match = regex.exec(solutionCards.rows[0].solution)) !== null) {
      const [, category, value] = match;
      resultArray.push([category, value]);
    }

    return resultArray;
  } catch (error) {
    console.error('An error occurred:', error);
    throw error
  }
}

function getRandomRooms(playerCount: number): number[][] {
  // Shuffle the rooms array to randomize the selection
  const shuffledRooms = rooms.sort(() => Math.random() - 0.5);

  // Return the specified number of room combinations
  return shuffledRooms.slice(0, playerCount);
}

async function setSinglePlayerCoords(email: string, room: number[], gameid: string): Promise<void> {

  try {
    await sql`
      UPDATE Players
      SET XCoord = ${room[0]}, YCoord = ${room[1]}
      WHERE email = ${email} AND gameid = ${gameid}`;
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }

}

type SetPlayerCoordsFunction = (playerEmails: string[], playerRooms: number[][], gameid: string) => Promise<void>;

const setPlayerCoords: SetPlayerCoordsFunction = async (playerEmails, playerRooms, gameid) => {

  try {
    if (playerEmails.length !== playerRooms.length) {
      throw new Error('Player emails and rooms arrays must have the same length');
    }

    let i = 0;
    for (const email of playerEmails) {
      await sql`
        UPDATE Players
        SET XCoord = ${playerRooms[i][0]}, YCoord = ${playerRooms[i][1]}
        WHERE email = ${email} AND gameid = ${gameid}`;

      i++;
      }
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
  
};

async function getAllPlayerCoords(gameid: string): Promise<{ [email: string]: number[][] }> {

  try {
    const playerCoords: { [email: string]: number[][] } = {};

    const playerData = await sql`
      SELECT email, XCoord, YCoord
      FROM Players
      WHERE gameid = ${gameid}`;

    for (const row of playerData.rows) {
      const email = row.email
      const XCoord = row.xcoord
      const YCoord = row.ycoord

      if (!playerCoords[email]) {
        playerCoords[email] = [];
      }

      playerCoords[email].push([XCoord, YCoord]);
    }

    return playerCoords;

  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
  
}

async function getPlayerCoords(email: string, gameid: string): Promise<number[]> {
  try {
    const playerCoords: number[][] = [];

    const playerData = await sql`
      SELECT XCoord, YCoord
      FROM Players
      WHERE gameid = ${gameid} AND email = ${email}`;

    for (const row of playerData.rows) {
      const XCoord: number = row.xcoord;
      const YCoord: number = row.ycoord;
      playerCoords.push([XCoord, YCoord]);
    }

    return playerCoords[0];

  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

type GameboardClueRooms = {
  [key: string]: { name: string };
};

const gameboardClueRooms: GameboardClueRooms = {
  "0,0": { name: "Study" },
  "0,2": { name: "Hall" },
  "0,4": { name: "Lounge" },
  "2,0": { name: "Library" },
  "2,2": { name: "Billiard Room" },
  "2,4": { name: "Dining Room" },
  "4,0": { name: "Conservatory" },
  "4,2": { name: "Ballroom" },
  "4,4": { name: "Kitchen" },
};

async function getPlayerRoom(email: string, gameid: string): Promise<string> {
  try {
    const playerCoords: number[][] = [];

    const playerData = await sql`
      SELECT XCoord, YCoord
      FROM Players
      WHERE gameid = ${gameid} AND email = ${email}`;

    for (const row of playerData.rows) {
      const XCoord: number = row.xcoord;
      const YCoord: number = row.ycoord;
      playerCoords.push([XCoord, YCoord]);
    }

    const coordinateString: string = playerCoords.join(",");
    const roomAtCoordinates = gameboardClueRooms[coordinateString];

    return roomAtCoordinates.name

  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

// if the move is allowed and the spot exists, it will execute the move and return true. otherwise, false
async function processPlayerMove(coordsString: string, email: string, gameid: string): Promise<string> {
  try {

    const playerCoordsBeforeTemp = await getPlayerCoords(email, gameid);
    const playerCoordsBefore: [number, number] = [playerCoordsBeforeTemp[0], playerCoordsBeforeTemp[1]];
    const playerCoordsAfter = parseCoords(coordsString);
    const action: string = email + " moved their character.";

    if (playerCoordsAfter === null) {
      return "Invalid room.";
    }

    if (!(isOneCellAway(playerCoordsBefore, playerCoordsAfter) || isSecretPassage(playerCoordsBefore, playerCoordsAfter))) {
      return "Invalid move. You must move to a room or hallway adjacent to your current spot."
    }

    if (await isCellOccupied(gameid, [playerCoordsAfter[0], playerCoordsAfter[1]])) {
      return "Invalid move. Cell is already occupied. Only one player per room or hallway except during suggestions."
    }

    await setMostRecentAction(gameid, action);
    await setSinglePlayerCoords(email, [playerCoordsAfter[0], playerCoordsAfter[1]], gameid);
    return "success";

  } catch (error) {
    // Handle any errors that might occur during processing
    console.error("Error processing move:", error);
    throw new Error("Error processing move");
  }
}

function parseCoords(coords: string): [number, number] | null {
  // Remove whitespace and brackets from the input string
  const cleanedCoords = coords.replace(/\s|\[|\]/g, '');

  // Split the cleaned string into an array of strings separated by comma
  const coordValues = cleanedCoords.split(',');

  // Check if there are exactly two values after splitting
  if (coordValues.length !== 2) {
    return null; // Return null if there are not exactly two values
  }

  // Parse the string values into numbers
  const x = parseFloat(coordValues[0]);
  const y = parseFloat(coordValues[1]);

  // Check if parsing was successful
  if (isNaN(x) || isNaN(y)) {
    return null; // Return null if parsing failed
  }

  // Return the coordinates as a tuple
  return [x, y];
}

function isOneCellAway(coordsBefore: [number, number], coordsAfter: [number, number]): boolean {
  const [xBefore, yBefore] = coordsBefore;
  const [xAfter, yAfter] = coordsAfter;

  // Calculate the absolute difference in x and y coordinates
  const deltaX = Math.abs(xAfter - xBefore);
  const deltaY = Math.abs(yAfter - yBefore);

  // Check if either deltaX or deltaY is 1, meaning coordsAfter is one cell away
  return (deltaX === 1 && deltaY === 0) || (deltaY === 1 && deltaX === 0);
}

function isSecretPassage(playerCoordsBefore: [number, number], playerCoordsAfter: [number, number]): boolean {
  const [xBefore, yBefore] = playerCoordsBefore;
  const [xAfter, yAfter] = playerCoordsAfter;

  // Check for each specific secret passage
  if (xBefore === 0 && yBefore === 0 && xAfter === 4 && yAfter === 4) {
      return true;
  }
  if (xBefore === 0 && yBefore === 4 && xAfter === 4 && yAfter === 0) {
      return true;
  }
  if (xBefore === 4 && yBefore === 0 && xAfter === 0 && yAfter === 4) {
      return true;
  }
  if (xBefore === 4 && yBefore === 4 && xAfter === 0 && yAfter === 0) {
      return true;
  }

  // If none of the secret passages matched
  return false;
}

async function isCellOccupied(gameid: string, targetCoord: number[]): Promise<boolean> {
  try {
    const playerData = await sql`
      SELECT COUNT(*)
      FROM Players
      WHERE gameid = ${gameid} AND XCoord = ${targetCoord[0]} AND YCoord = ${targetCoord[1]}`;

    const count = playerData.rows[0].count;
    const isOccupied = count > 0;

    return isOccupied;
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function isPlayerTurn(gameid: string, email: string): Promise<boolean> {
  try {
    // Get the player's turn order
    const { rows: playerTurnOrder } = await sql`
      SELECT turnorder
      FROM Players
      WHERE gameid = ${gameid} AND email = ${email}
      LIMIT 1;
    `;
    
    if (playerTurnOrder.length === 0) {
      throw new Error(`Player with email ${email} not found in game with ID ${gameid}`);
    }
    
    const turnorder = playerTurnOrder[0].turnorder;

    // Get the current turn from the game
    const { rows: currentTurn } = await sql`
      SELECT currentturn
      FROM Games
      WHERE gameid = ${gameid}
      LIMIT 1;
    `;
    
    if (currentTurn.length === 0) {
      throw new Error(`Game with ID ${gameid} not found`);
    }
    
    const gameCurrentTurn = currentTurn[0].currentturn;

    // Check if player's turn matches game's current turn
    return gameCurrentTurn === turnorder;

  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

const suspectNames = [
  'Miss Scarlet', 'Professor Plum', 'Mrs. Peacock',
  'Mr. Green', 'Colonel Mustard', 'Mrs. White'
]

const roomNames = [
  'Kitchen', 'Ballroom', 'Conservatory', 'Dining room',
  'Billiard Room', 'Library', 'Lounge', 'Hall', 'Study'
];

const weaponNames = [
  'Revolver', 'Candlestick', 'Knife',
  'Lead Pipe', 'Wrench', 'Rope'
];

// Function to check if a player is in a room
async function isPlayerInRoom(gameid: string, email: string): Promise<string | null> {
  try {
    const playerData = await sql`
      SELECT XCoord, YCoord
      FROM Players
      WHERE gameid = ${gameid} AND email = ${email}`;

    const XCoord: number = playerData.rows[0].xcoord;
    const YCoord: number = playerData.rows[0].ycoord;

    // Iterate through the rooms to check if the player is in any of them
    for (let i = 0; i < rooms.length; i++) {
      if (rooms[i][0] === XCoord && rooms[i][1] === YCoord) {
        return roomNames[i];
      }
    }

    return null; // Player is not in any room
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function isPlayerActive(gameid: string, email: string): Promise<boolean> {
  try {
    const playerData = await sql`
      SELECT Active
      FROM Players
      WHERE gameid = ${gameid} AND email = ${email}`;
    const active: boolean = playerData.rows[0].active;
    return active
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function deactivatePlayer(gameid: string, email: string): Promise<void> {
  try {
    await sql`
      UPDATE Players
      SET Active = false
      WHERE gameid = ${gameid} AND email = ${email}`;

  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function isGameOver(gameid: string): Promise<boolean> {
  try {
    const { rows: solutionRevealed } = await sql`
      SELECT SolutionRevealed
      FROM Games
      WHERE gameid = ${gameid}
      LIMIT 1;`;

    const isSolutionRevealed = solutionRevealed.length > 0 && solutionRevealed[0].solutionrevealed === true;

    const { rows: activePlayersCount } = await sql`
      SELECT COUNT(*)
      FROM Players
      WHERE gameid = ${gameid} AND Active = true;`;
    
    const numberOfActivePlayers = activePlayersCount[0].count;

    return isSolutionRevealed || numberOfActivePlayers == 1

  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function getWinner(gameid: string): Promise<string | null> {
  try {
    const { rows: activePlayers } = await sql`
      SELECT email
      FROM Players
      WHERE gameid = ${gameid} AND Active = true;`;

    if (activePlayers.length === 1) {
      // If there's only one active player left, they are the winner
      return activePlayers[0].email;
    } else {
      // If there are no active players left, return null indicating no winner
      return null;
    }
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function processPlayerSuggestion(suggestion: string, email: string, gameid: string): Promise<string> {

  try {

    // Parse the suggestion
    const [suspect, weapon] = suggestion.split(', ');

    // Validate the suspect and weapon
    if (!suspectNames.includes(suspect) || !weaponNames.includes(weapon)) {
      return "invalid";
    }

    // move suggested suspect to suggestor's square
    const { rows: playerData } = await sql`
      SELECT email
      FROM Players
      WHERE character ILIKE ${suspect} AND gameid = ${gameid}
      LIMIT 1;
    `;

    const suggesteeEmail = playerData.length > 0 ? playerData[0].email : null;

    if (suggesteeEmail !== null) {
      await setSinglePlayerCoords(suggesteeEmail, (await getPlayerCoords(email, gameid)), gameid);
    }

    const room = await getPlayerRoom(email, gameid);

    const action: string = email + " suggested that " + suspect + " killed someone with a " + weapon + " in the " + room + ". ";

    const { rows: gameData } = await sql`
      SELECT CurrentTurn, TurnCount
      FROM Games
      WHERE gameid = ${gameid}
      LIMIT 1;
    `;

    const originalTurn = gameData.length > 0 ? gameData[0].currentturn : null;
    const turnCount = gameData.length > 0 ? gameData[0].turncount : null;
    let currTurn = originalTurn + 1;
    if (currTurn > turnCount) {
      currTurn = 1;
    }

    while (currTurn != originalTurn) {
      const { rows: playerEmail } = await sql`
        SELECT email
        FROM Players
        WHERE gameid = ${gameid} AND TurnOrder = ${currTurn}
        LIMIT 1;`;
      const currPlayerEmail = playerEmail.length > 0 ? playerEmail[0].email : null;

      const currPlayerCards = await getPlayerCards(currPlayerEmail);

      let matches: string[] = [];

      for (const card of currPlayerCards) {
        const name = card[1];
  
        // Check if the card matches the suggestion
        if (name === suspect || name === weapon || name === room) {
          matches.push(name);
        }
      }

      if (matches.length > 0) {
        // If there are matches, randomly select one
        const randomMatch = matches[Math.floor(Math.random() * matches.length)];
        await setMostRecentAction(gameid, action + currPlayerEmail + " refuted this by showing " + randomMatch + ".");
        return `Refuted! ${randomMatch} was shown. `;
      } 

      currTurn++;
      if (currTurn > turnCount) {
        currTurn = 1;
      }
    }

    await setMostRecentAction(gameid, action + "No one could refute their suggestion!");
    return "No one could refute your suggestion! ";

  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }

}

async function processPlayerAccusation(accusation: string, email: string, gameid: string): Promise<string> {

  try {

    // Parse the suggestion
    const [suspect, weapon, room] = accusation.split(', ');
    const action: string = email + " accused " + accusation + ". ";

    // Validate the suspect and weapon
    if (!suspectNames.includes(suspect) || !weaponNames.includes(weapon) || !roomNames.includes(room)) {
      return "invalid";
    }

    // Check if the accusation matches the solution
    const solution = await getSolutionCards(gameid);
    const solutionSuspect = solution.find(card => card[0] === 'Suspect')?.[1];
    const solutionWeapon = solution.find(card => card[0] === 'Weapon')?.[1];
    const solutionRoom = solution.find(card => card[0] === 'Room')?.[1];

    if (solutionSuspect === suspect && solutionWeapon === weapon && solutionRoom === room) {
      // Accusation is correct
      await setMostRecentAction(gameid, action + "They were correct! Congrats to " + email + " on the win!")
      return "true";
    } else {
      // Accusation is incorrect
      await setMostRecentAction(gameid, action + "They were incorrect. " + email + " has been eliminated.")
      return "false";
    }

  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }

}

// updates turn and returns the next player's email
async function updateTurn(gameid: string): Promise<string> {
  try {
    const { rows: updatedTurn } = await sql`
          WITH updated AS (
            UPDATE Games
            SET CurrentTurn = CurrentTurn + 1
            WHERE gameid = ${gameid}
            RETURNING CurrentTurn, TurnCount
          )
          SELECT CurrentTurn, TurnCount
          FROM updated;
        `;
    let currentTurn = updatedTurn[0].currentturn;
    if (updatedTurn[0].currentturn > updatedTurn[0].turncount) { // reset currentTurn to 1 for starting over at first player
      const { rows: updatedTurn } = await sql`
        UPDATE Games
        SET CurrentTurn = 1
        WHERE gameid = ${gameid}
        RETURNING CurrentTurn;
      `;
      currentTurn = updatedTurn[0].currentturn;
    }
    const { rows: playerEmail } = await sql`
          SELECT email
          FROM Players
          WHERE gameid = ${gameid}
          AND TurnOrder = ${currentTurn}
          LIMIT 1;`;
    let emailRet = playerEmail[0].email;
    while (!(await isPlayerActive(gameid, emailRet))) { // keep changing turns until we get to an active player
      const { rows: updatedTurn } = await sql`
          WITH updated AS (
            UPDATE Games
            SET CurrentTurn = CurrentTurn + 1
            WHERE gameid = ${gameid}
            RETURNING CurrentTurn, TurnCount
          )
          SELECT CurrentTurn, TurnCount
          FROM updated;
        `;
      let currentTurn = updatedTurn[0].currentturn;
      if (updatedTurn[0].currentturn > updatedTurn[0].turncount) { // reset currentTurn to 1 for starting over at first player
        const { rows: updatedTurn } = await sql`
          UPDATE Games
          SET CurrentTurn = 1
          WHERE gameid = ${gameid}
          RETURNING CurrentTurn;
        `;
        currentTurn = updatedTurn[0].currentturn;
      }
      const { rows: playerEmail } = await sql`
            SELECT email
            FROM Players
            WHERE gameid = ${gameid}
            AND TurnOrder = ${currentTurn}
            LIMIT 1;`;
      emailRet = playerEmail[0].email;
    }
    return emailRet
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

// fetches the current player's turn without updating it
async function whoseTurnIsIt(gameid: string): Promise<string> {
  try {
    if (await isGameOver(gameid)) {
      return "Game Over!";
    }

    const { rows: CurrentTurn } = await sql`SELECT CurrentTurn FROM Games WHERE gameid = ${gameid} LIMIT 1`;
    const currentTurn = CurrentTurn[0]?.currentturn;

    if (!currentTurn) {
      throw new Error("Current turn is not defined.");
    }

    const { rows: playerEmail } = await sql`
      SELECT email
      FROM Players
      WHERE gameid = ${gameid}
      AND TurnOrder = ${currentTurn}
      LIMIT 1;
    `;

    if (playerEmail.length === 0) {
      throw new Error("Player email not found.");
    }

    return playerEmail[0].email;
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function setGameStatus(gameid: string, status: string): Promise<void> {
  try {
    await sql`
      UPDATE Games
      SET GameState = ${status}
      WHERE gameid = ${gameid}`;
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function getGameStatus(gameid: string): Promise<string> {
  try {
    const { rows } = await sql`
      SELECT GameState
      FROM Games
      WHERE gameid = ${gameid}
      LIMIT 1;
    `;

    if (rows.length === 0) {
      throw new Error(`Game with ID ${gameid} not found`);
    }

    return rows[0].gamestate;
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function fetchPlayersWithCharacters(gameid: string): Promise<{ [email: string]: string }> {
  try {
    const { rows: playerData } = await sql`
      SELECT email, character
      FROM Players
      WHERE gameid = ${gameid};
    `;

    const playersWithCharacters: { [email: string]: string } = {};
    playerData.forEach((player) => {
      const email = player.email as string;
      const character = player.character as string;
      playersWithCharacters[email] = character;
    });

    return playersWithCharacters;

  } catch (error) {
    console.error('An error occurred while fetching players:', error);
    throw error;
  }
}

async function fetchPlayersWithIcons(gameid: string): Promise<{ [email: string]: string }> {
  try {
    const { rows: playerData } = await sql`
      SELECT p.email, u.image
      FROM Players p
      INNER JOIN Users u ON p.email = u.email
      WHERE p.gameid = ${gameid};
    `;

    const playersWithIcons: { [email: string]: string } = {};
    playerData.forEach((player) => {
      const email = player.email as string;
      const image = player.image as string;
      playersWithIcons[email] = image;
    });

    return playersWithIcons;

  } catch (error) {
    console.error('An error occurred while fetching players with icons:', error);
    throw error;
  }
}

async function setMostRecentAction(gameid: string, action: string): Promise<void> {
  try {
    await sql`
      UPDATE Games
      SET MostRecentAction = ${action}
      WHERE gameid = ${gameid}`;
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function getMostRecentAction(gameid: string): Promise<string> {
  try {
    const { rows } = await sql`
      SELECT MostRecentAction
      FROM Games
      WHERE gameid = ${gameid}
      LIMIT 1;
    `;

    if (rows.length === 0) {
      throw new Error(`Game with ID ${gameid} not found`);
    }

    return rows[0].mostrecentaction;
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function appendMostRecentAction(gameid: string, action: string): Promise<void> {
  try {
    // Get the current most recent action
    const currentAction = await getMostRecentAction(gameid);

    // Concatenate the new action with the current one
    const updatedAction = currentAction + " " + action;

    // Update the Games table with the updated action
    await sql`
      UPDATE Games
      SET MostRecentAction = ${updatedAction}
      WHERE gameid = ${gameid}`;
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}

async function setSolutionRevealed(gameid: string): Promise<void> {
  try {
    await sql`
      UPDATE Games
      SET SolutionRevealed = true
      WHERE gameid = ${gameid};
    `;
  } catch (error) {
    console.error('An error occurred:', error);
    throw error;
  }
}