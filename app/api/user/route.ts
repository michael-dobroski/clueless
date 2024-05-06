import { sql } from "@vercel/postgres";
import { NextResponse } from 'next/server';

{/***************
  * This file is a route. It is a serverless function that runs in the cloud.'
  * We can use this route to create users.
  * Just hit the route from the browser or use a tool like Postman to send a POST to the route.
  ***************/}

export async function GET (request: Request) {
  const { searchParams } = new URL(request.url);
  const email = searchParams.get('email');
  const name = searchParams.get('name');
  const image = searchParams.get('image');

  try {
    if (!email ) {
      return NextResponse.json({error: 'Missing email'}, {status: 400});
    }
    if (!name ) {
      return NextResponse.json({error: 'Missing name'}, {status: 400});
    }
    if (!image) {
      return NextResponse.json({error: 'Missing image'}, {status: 400});
    }
    await sql`
    INSERT INTO Users ( email, name, image ) 
    VALUES ( ${email}, ${name}, ${image} )`
  } catch (error) {
    return NextResponse.json({error}, {status: 500});
  }

  const users = await sql`SELECT * FROM Users`;
  return NextResponse.json({users}, {status: 200});
}


{/***************
  * We can use this route to PATCH users.
  * Just hit the route from the browser or use a tool like Postman to send a PATCH to the route
  * INPUT: email
  ***************/}

export async function PATCH (request: Request) {
  // JSON
  const data = await request.json();
  const email = data.email;
  const status = data.status;
  const image = data.image;
  const name = data.name;

  try {
    if ( !email || email === null || email === undefined ) {
      return NextResponse.json({error: 'Missing email'}, {status: 400});
    }
    if (  status || status !== null || !status !== undefined ){
      await sql`
      UPDATE Users SET status = ${status} WHERE email = ${email}` 
    }
    if ( name != null || name != undefined){
      await sql`
      UPDATE Users SET name = ${name} WHERE email = ${email}` 
    }
    if ( image != null || image != undefined ){
      await sql`
      UPDATE Users SET image = ${image} WHERE email = ${email}` 
    }
  } catch (error) {
    return NextResponse.json({error}, {status: 500});
  }

  const users = await sql`SELECT * FROM Users`; //WHERE email = ${email}
  console.log(users);
  return NextResponse.json(users, {status: 200});
}

export async function DELETE (request: Request) {
  // JSON
  const data = await request.json();
  const email = data.email;
  const gameid = data.gameid;

  try {
    if (gameid === "false") {
      if (!email ) {
        return NextResponse.json({error: 'Missing email'}, {status: 400});
      }
      await sql`DELETE FROM Users WHERE email = ${email}`;
      return NextResponse.json({message: 'User deleted successfully'}, {status: 200});
    }
    if (email === "false") {
      if (!gameid ) {
        return NextResponse.json({error: 'Missing game'}, {status: 400});
      }
      // First, delete related player records
      await sql`DELETE FROM Players WHERE gameid = ${gameid}`;
      // Then, delete the game
      await sql`DELETE FROM Games WHERE gameid = ${gameid}`;
      return NextResponse.json({message: 'Game deleted successfully'}, {status: 200});
    }
    return NextResponse.json({message: 'There was an error.'}, {status: 200});
  } catch (error) {
    console.log(error)
    return NextResponse.json({error}, {status: 500});
  }
}