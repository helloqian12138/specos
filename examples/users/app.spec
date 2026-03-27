App: This is a User Manager System

Goal:
  Describe your system here.

Environment:
  Frontend: React + Ant Design + TypeScript
  Backend: Python + Flask
  Data: MongoDB

Theme:
  primaryColor = #ff1919
  fontSize = 14px

---

Entity User:
  id: string (primary)
  name: string (required, maxLength=100)
  age: number (min=0,max=150)
  city: string
  sex: number(0,1)
  active: boolean (default=false)

---

Action CreateUser:
  Input:
    name,age,sex,city
  Do:
    insert User:
      name = input.name
      age = input.age
      sex = input.sex
      city = input.city
      active = true
  Return:
    success
    id

---

Action SearchUsers:
  Input:
    searchKey = "" (optional)
    page
    pageSize
  Do:
    query User:
      where active = true
      and name contains searchKey
    paginate by page, pageSize
  Return:
    data: User[]
    total
  onError:
    message: User search failed

---

Action DeleteUser:
  Input:
    id
  Do:
    update User:
      where id = input.id
      set active = false
  Return:
    success

---

Page UsersPage (/users):

  Header:
    text("DEMO USER MANAGE", align=center)

  Content:

    Section ActionBar:
      layout: flex(space-between)

      Left:
        input(searchKey)
        button("Search"):
          onClick:
            dispatch SearchUsers
            refresh users

      Right:
        button("Add User", primary):
          onClick:
            openModal CreateUserModal

    Section List:
      table(users):
        columns:
          id
          title
          action:
            button("Delete"):
              onClick:
                dispatch DeleteUser(id = row.id)
                refresh users

---

Component CreateUserModal:

  modal("Create User"):

    form:
      field name (input, required)
      field age (input-number)
      field sex (radio, [Male, Female])
      field city (input)

    onSubmit:
      dispatch CreateUser(name,age,sex,city)
      refresh todos
      closeModal

---

State:

  users:
    source: SearchUsers
    autoLoad: true
    page = 1
    pageSize = 10
